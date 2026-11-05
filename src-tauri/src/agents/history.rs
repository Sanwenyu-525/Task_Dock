//! Agent 历史会话 / 轮次的后端分页查询（P1-02）。
//!
//! 实时快照（`snapshot_query`）只取最近 200 个会话 / 300 个轮次，用于监控树、
//! 状态聚合与托盘；它**不是**历史数据源。本模块提供独立的只读分页查询：
//! 数量由独立 `COUNT(*)` 聚合给出，翻页使用 keyset 游标，因此不受快照上限影响，
//! 也不会因为深页 `OFFSET` 越来越慢。前端「历史会话」「历史搜索结果」「会话轮次」
//! 都按需调用这里的查询，快照仍只负责实时状态。
//!
//! 排序与游标稳定性：
//! - 会话：`(last_seen_at DESC, id DESC)`；轮次：`(updated_at DESC, id DESC)`。
//! - 游标由本模块签发（不透明 JSON 字符串），调用方不得自行构造；会话游标与轮次
//!   游标结构不同，混用会被拒绝。
//! - 翻页期间新插入的更晚记录只会出现在游标之前（已加载区域），不会造成重复；
//!   旧记录仍然按稳定顺序出现在后续页。已有记录若因新事件更新 `last_seen_at` 而
//!   移到游标之前，会由实时分区展示，历史分页不会重复返回它。
//!
//! 关键词匹配范围：会话标题、`external_id`、关联轮次 `task_title`。`LIKE` 的大小写
//! 折叠与 SQLite 一致（ASCII 不区分大小写；中文等无大小写字符按原样匹配），
//! `%` / `_` / `\` 会被转义为字面量，不会被当成通配符。

use serde::{Deserialize, Serialize};

use crate::db::{AgentRun, Db};
use crate::error::{AppError, AppResult};

/// 单页上限：前端「显示更多」每次 10 条，搜索结果也复用该上限。
const MAX_LIMIT: i64 = 100;
const DEFAULT_LIMIT: i64 = 20;
const MAX_KEYWORD_LEN: usize = 200;
const MAX_FILTER_ID_LEN: usize = 256;
const CURSOR_VERSION: u8 = 1;
const MAX_GROUPS: i64 = 2000;

/// 实时会话判定：与前端 `agentTree::liveRuns` 同一口径——
/// - running / waiting 永远算实时；
/// - failed / disconnected 仅在最近 1 小时内算实时；
/// - completed / 更早的失败与失联算历史。
///
/// 不使用 `agent_sessions.status` 单独判定：会话状态字段可能是最后一次事件状态，
/// 而前端监控树以「轮次证据」计算 liveState；两边必须使用同一口径，否则同一会话
/// 会同时出现在实时树与历史列表/COUNT 中。
fn live_session_sql(session_alias: &str) -> String {
    let live_run = live_run_sql("lr");
    format!(
        "EXISTS (SELECT 1 FROM agent_runs lr \
         WHERE lr.session_id = {session_alias}.id AND lr.origin = 'real' \
           AND ({live_run}))"
    )
}

/// 实时轮次谓词（表别名）：running/waiting 恒为实时，failed/disconnected 仅近 1 小时。
/// 与前端 `liveRuns()` 使用同一窗口，历史轮次分区据此与实时轮次互斥。
fn live_run_sql(run_alias: &str) -> String {
    format!(
        "{run_alias}.status IN ('running','waiting') \
         OR ({run_alias}.status IN ('failed','disconnected') \
             AND datetime({run_alias}.updated_at) >= datetime('now','-1 hour'))"
    )
}


/// 会话历史查询条件。前端传 camelCase；未提供的字段表示不筛选。
///
/// - `sourceId` / `instanceId`：真实来源与实例关系筛选；
/// - `unassigned`：只查「未关联到任何已知实例」的会话（实例被删除/事件未带实例）。
///   与 `instanceId` 同时提供时以 `instanceId` 为准；
/// - `status`：会话状态（支持 `running/working` 等别名，落库值统一为规范状态）；
/// - `keyword`：标题 / external_id / 关联轮次任务标题子串；
/// - `sessionId`：按会话行 ID 精确查找（通知定位用）。命中时忽略游标，
///   返回单条结果与准确的 `total`；
/// - `limit`：1..100，默认 20。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionHistoryQuery {
    pub source_id: Option<String>,
    pub instance_id: Option<String>,
    pub unassigned: Option<bool>,
    pub status: Option<String>,
    pub keyword: Option<String>,
    pub session_id: Option<String>,
    /// 是否把实时会话也算进历史结果。默认 false：历史列表/COUNT 与实时树互斥。
    /// 精确按会话 ID 定位（find_session）会显式传 true。
    pub include_live: Option<bool>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

/// 历史会话条目：字段与实时快照的 `AgentSession` 对齐，额外给出 `run_count`。
/// 响应字段保持仓库既有的 snake_case 约定（与 `AgentSession` / `AgentRun` 一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHistorySession {
    pub id: String,
    pub source_id: String,
    pub instance_id: Option<String>,
    pub external_id: String,
    pub title: String,
    pub status: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub last_run_id: Option<String>,
    /// 该会话的真实（origin='real'）轮次数量，独立 COUNT 聚合，只作展示，不参与分页。
    pub run_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionHistoryPage {
    pub items: Vec<AgentHistorySession>,
    /// 当前筛选条件下的全库总数（与游标无关，翻页过程中保持稳定口径）。
    pub total: i64,
    /// 下一页游标；`None` 表示没有更多。
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentRunHistoryPage {
    pub items: Vec<AgentRun>,
    pub total: i64,
    pub next_cursor: Option<String>,
}

/// 历史入口分组：按真实 source / instance 聚合历史会话数量。
/// 只返回数量与实例元数据，不加载会话正文；用于在监控树上补出「只有历史、
/// 当前快照没有近期会话」的实例入口。
#[derive(Debug, Clone, Serialize)]
pub struct AgentHistoryGroup {
    pub source_id: String,
    /// NULL 表示未关联实例或实例行已失效；前端归入「未关联实例」。
    pub instance_id: Option<String>,
    pub instance_key: Option<String>,
    pub display_name: Option<String>,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentHistoryGroups {
    pub items: Vec<AgentHistoryGroup>,
    /// 分组数超过上限时为 true；前端如实提示，不静默丢弃。
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistoryGroupQuery {
    pub source_id: Option<String>,
    pub include_live: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoryCursor {
    v: u8,
    last_seen_at: String,
    id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RunCursor {
    v: u8,
    updated_at: String,
    id: String,
}

/// 统一 SQL 过滤片段：`clause` 只含占位符，参数按顺序放入 `params`。
struct SqlFilter {
    clause: String,
    params: Vec<Box<dyn rusqlite::ToSql>>,
}

impl SqlFilter {
    fn refs(&self) -> Vec<&dyn rusqlite::ToSql> {
        self.params.iter().map(|p| p.as_ref()).collect()
    }
}

fn normalize_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

/// 空字符串/纯空白视为未提供；过长直接拒绝（避免把超长模式送进 LIKE）。
fn normalize_id(raw: Option<&str>, field: &str) -> AppResult<Option<String>> {
    let Some(v) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if v.chars().count() > MAX_FILTER_ID_LEN {
        return Err(AppError::Validation(format!("{field} 过长")));
    }
    Ok(Some(v.to_string()))
}

fn normalize_status(raw: Option<&str>) -> AppResult<Option<String>> {
    let Some(v) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let state = crate::agents::AgentState::parse(v)
        .ok_or_else(|| AppError::Validation(format!("未知会话状态: {v}")))?;
    Ok(Some(state.as_str().to_string()))
}

fn normalize_keyword(raw: Option<&str>) -> AppResult<Option<String>> {
    let Some(v) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if v.chars().count() > MAX_KEYWORD_LEN {
        return Err(AppError::Validation("关键词过长（最多 200 个字符）".into()));
    }
    Ok(Some(v.to_string()))
}

/// 转义 LIKE 元字符，使用户输入按字面量匹配。
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn encode_cursor<T: Serialize>(cursor: &T) -> AppResult<String> {
    Ok(serde_json::to_string(cursor)?)
}

fn parse_session_cursor(raw: &str) -> AppResult<HistoryCursor> {
    let cursor: HistoryCursor =
        serde_json::from_str(raw).map_err(|_| AppError::Validation("历史会话游标无效".into()))?;
    if cursor.v != CURSOR_VERSION || cursor.last_seen_at.is_empty() || cursor.id.is_empty() {
        return Err(AppError::Validation("历史会话游标无效".into()));
    }
    Ok(cursor)
}

fn parse_run_cursor(raw: &str) -> AppResult<RunCursor> {
    let cursor: RunCursor =
        serde_json::from_str(raw).map_err(|_| AppError::Validation("历史轮次游标无效".into()))?;
    if cursor.v != CURSOR_VERSION || cursor.updated_at.is_empty() || cursor.id.is_empty() {
        return Err(AppError::Validation("历史轮次游标无效".into()));
    }
    Ok(cursor)
}

fn build_session_filter(query: &AgentSessionHistoryQuery) -> AppResult<SqlFilter> {
    let mut clauses = vec![
        "s.origin = 'real'".to_string(),
        // 隐藏来源不进历史树/搜索；用户重新显示来源后自动恢复可查。
        "s.source_id IN (SELECT id FROM agent_sources WHERE hidden = 0)".to_string(),
    ];
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    // 默认排除实时会话：与前端监控树 `liveState !== idle` 同一口径。
    if !query.include_live.unwrap_or(false) {
        clauses.push(format!("NOT {}", live_session_sql("s")));
    }

    if let Some(source_id) = normalize_id(query.source_id.as_deref(), "source_id")? {
        clauses.push("s.source_id = ?".into());
        params.push(Box::new(source_id));
    }

    let instance_id = normalize_id(query.instance_id.as_deref(), "instance_id")?;
    if let Some(instance_id) = instance_id {
        clauses.push("s.instance_id = ?".into());
        params.push(Box::new(instance_id));
    } else if query.unassigned.unwrap_or(false) {
        // 「未关联实例」= NULL 或指向已不存在的真实实例行；不伪造实例分组。
        // 与 query_groups 的 `i.origin='real'` 连接条件保持同一口径。
        clauses.push(
            "(s.instance_id IS NULL OR s.instance_id NOT IN (\
               SELECT id FROM agent_instances WHERE origin = 'real'))"
                .into(),
        );
    }

    if let Some(status) = normalize_status(query.status.as_deref())? {
        clauses.push("s.status = ?".into());
        params.push(Box::new(status));
    }

    if let Some(session_id) = normalize_id(query.session_id.as_deref(), "session_id")? {
        clauses.push("s.id = ?".into());
        params.push(Box::new(session_id));
    }

    if let Some(keyword) = normalize_keyword(query.keyword.as_deref())? {
        let pattern = format!("%{}%", escape_like(&keyword));
        clauses.push(
            "(s.title LIKE ? ESCAPE '\\' OR s.external_id LIKE ? ESCAPE '\\' OR EXISTS (\
               SELECT 1 FROM agent_runs r WHERE r.session_id = s.id AND r.origin = 'real' \
               AND r.task_title LIKE ? ESCAPE '\\'))"
                .into(),
        );
        params.push(Box::new(pattern.clone()));
        params.push(Box::new(pattern.clone()));
        params.push(Box::new(pattern));
    }

    Ok(SqlFilter {
        clause: clauses.join(" AND "),
        params,
    })
}

/// 会话历史分页。只读连接；COUNT 与数据页在同一连接上顺序执行，口径一致。
pub fn query_sessions(
    db: &Db,
    query: &AgentSessionHistoryQuery,
) -> AppResult<AgentSessionHistoryPage> {
    let limit = normalize_limit(query.limit);
    let filter = build_session_filter(query)?;
    // 按会话 ID 定位是精确查找：游标没有意义，直接忽略。
    let cursor = if query
        .session_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty())
    {
        None
    } else {
        query
            .cursor
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(parse_session_cursor)
            .transpose()?
    };

    db.with_read(|conn| {
        // 同一读事务内先 COUNT 再取页：并发写入不会让 total 与 items 落在不同快照。
        let tx = conn.unchecked_transaction()?;
        let total: i64 = tx.query_row(
            &format!(
                "SELECT COUNT(*) FROM agent_sessions s WHERE {}",
                filter.clause
            ),
            filter.refs().as_slice(),
            |r| r.get(0),
        )?;

        let mut sql = format!(
            "SELECT s.id, s.source_id,
                    CASE WHEN EXISTS (SELECT 1 FROM agent_instances i
                                      WHERE i.id = s.instance_id AND i.origin = 'real')
                         THEN s.instance_id ELSE NULL END AS instance_id,
                    s.external_id, s.title, s.status,
                    s.first_seen_at, s.last_seen_at, s.last_run_id,
                    (SELECT COUNT(*) FROM agent_runs r
                      WHERE r.session_id = s.id AND r.origin = 'real') AS run_count
             FROM agent_sessions s WHERE {}",
            filter.clause
        );
        let mut params = filter.params;
        if let Some(cursor) = &cursor {
            sql.push_str(" AND (s.last_seen_at < ? OR (s.last_seen_at = ? AND s.id < ?))");
            params.push(Box::new(cursor.last_seen_at.clone()));
            params.push(Box::new(cursor.last_seen_at.clone()));
            params.push(Box::new(cursor.id.clone()));
        }
        sql.push_str(" ORDER BY s.last_seen_at DESC, s.id DESC LIMIT ?");
        params.push(Box::new(limit + 1));

        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = tx.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |r| {
            Ok(AgentHistorySession {
                id: r.get(0)?,
                source_id: r.get(1)?,
                instance_id: r.get(2)?,
                external_id: r.get(3)?,
                title: r.get(4)?,
                status: r.get(5)?,
                first_seen_at: r.get(6)?,
                last_seen_at: r.get(7)?,
                last_run_id: r.get(8)?,
                run_count: r.get(9)?,
            })
        })?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next_cursor = if has_more {
            items
                .last()
                .map(|s| {
                    encode_cursor(&HistoryCursor {
                        v: CURSOR_VERSION,
                        last_seen_at: s.last_seen_at.clone(),
                        id: s.id.clone(),
                    })
                })
                .transpose()?
        } else {
            None
        };
        drop(stmt);
        tx.commit()?;
        Ok(AgentSessionHistoryPage {
            items,
            total,
            next_cursor,
        })
    })
}

/// 单个会话的轮次历史分页。`session_id` 必须是已存在的会话行 ID；
/// 不存在时返回空页（total=0），不伪造结果。
///
/// 默认排除实时轮次（`include_live=false`）：调用方从快照渲染实时轮次，
/// 历史分区只列已结束的轮次，`COUNT` 与列表同口径；通知深链需要完整轮次时可显式
/// 传 `include_live=true`。
pub fn query_runs(
    db: &Db,
    session_id: &str,
    cursor: Option<&str>,
    limit: Option<i64>,
    include_live: Option<bool>,
) -> AppResult<AgentRunHistoryPage> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.chars().count() > MAX_FILTER_ID_LEN {
        return Err(AppError::Validation("session_id 不合法".into()));
    }
    let limit = normalize_limit(limit);
    let cursor = cursor
        .filter(|s| !s.trim().is_empty())
        .map(parse_run_cursor)
        .transpose()?;
    let live_clause = if include_live.unwrap_or(false) {
        String::new()
    } else {
        format!(" AND NOT ({})", live_run_sql("r"))
    };

    db.with_read(|conn| {
        let tx = conn.unchecked_transaction()?;
        let total: i64 = tx.query_row(
            &format!(
                "SELECT COUNT(*) FROM agent_runs r \
                 WHERE r.origin = 'real' AND r.session_id = ?1{live_clause}"
            ),
            rusqlite::params![session_id],
            |r| r.get(0),
        )?;

        let mut sql = format!(
            "SELECT r.id, r.session_id, r.source_id, r.external_run_id, r.task_title, r.status,
                    r.started_at, r.updated_at, r.ended_at, r.pending_items, r.instance_id
             FROM agent_runs r
             WHERE r.origin = 'real' AND r.session_id = ?1{live_clause}"
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(session_id.to_string())];
        if let Some(cursor) = &cursor {
            sql.push_str(" AND (r.updated_at < ? OR (r.updated_at = ? AND r.id < ?))");
            params.push(Box::new(cursor.updated_at.clone()));
            params.push(Box::new(cursor.updated_at.clone()));
            params.push(Box::new(cursor.id.clone()));
        }
        sql.push_str(" ORDER BY r.updated_at DESC, r.id DESC LIMIT ?");
        params.push(Box::new(limit + 1));

        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = tx.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |r| {
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
                pending_items: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or_default(),
                instance_id: r.get(10)?,
            })
        })?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next_cursor = if has_more {
            items
                .last()
                .map(|run| {
                    encode_cursor(&RunCursor {
                        v: CURSOR_VERSION,
                        updated_at: run.updated_at.clone(),
                        id: run.id.clone(),
                    })
                })
                .transpose()?
        } else {
            None
        };
        drop(stmt);
        tx.commit()?;
        Ok(AgentRunHistoryPage {
            items,
            total,
            next_cursor,
        })
    })
}

/// 历史入口分组查询：按 source + instance 聚合 COUNT，不加载会话明细。
/// 隐藏来源不返回（尊重用户隐藏）；已删除来源没有 agent_sources 行，也不会返回。
/// 实例行不存在的会话归入 `instance_id = NULL`（未关联实例），与原历史查询口径一致。
pub fn query_groups(
    db: &Db,
    query: &AgentHistoryGroupQuery,
) -> AppResult<AgentHistoryGroups> {
    let source_id = normalize_id(query.source_id.as_deref(), "source_id")?;
    db.with_read(|conn| {
        let mut clauses = vec![
            "s.origin = 'real'".to_string(),
            "src.hidden = 0".to_string(),
        ];
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if !query.include_live.unwrap_or(false) {
            clauses.push(format!("NOT {}", live_session_sql("s")));
        }
        if let Some(source_id) = source_id {
            clauses.push("s.source_id = ?".into());
            params.push(Box::new(source_id));
        }
        let sql = format!(
            "SELECT s.source_id,
                    CASE WHEN i.id IS NULL THEN NULL ELSE s.instance_id END AS instance_id,
                    i.instance_key, i.display_name, COUNT(*) AS n
             FROM agent_sessions s
             JOIN agent_sources src ON src.id = s.source_id
             LEFT JOIN agent_instances i ON i.id = s.instance_id AND i.origin = 'real'
             WHERE {}
             GROUP BY s.source_id,
                      CASE WHEN i.id IS NULL THEN NULL ELSE s.instance_id END,
                      i.instance_key, i.display_name
             ORDER BY s.source_id, n DESC
             LIMIT {}",
            clauses.join(" AND "),
            MAX_GROUPS + 1
        );
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |r| {
            Ok(AgentHistoryGroup {
                source_id: r.get(0)?,
                instance_id: r.get(1)?,
                instance_key: r.get(2)?,
                display_name: r.get(3)?,
                count: r.get(4)?,
            })
        })?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let truncated = items.len() as i64 > MAX_GROUPS;
        if truncated {
            items.truncate(MAX_GROUPS as usize);
        }
        Ok(AgentHistoryGroups { items, truncated })
    })
}

/// 按会话行 ID 精确定位（通知跳转/深链）：不存在返回 `None`，不伪造占位会话。
/// 精确定位允许命中实时会话（通知可能指向仍在运行的轮次）。
pub fn find_session(db: &Db, session_id: &str) -> AppResult<Option<AgentHistorySession>> {
    let query = AgentSessionHistoryQuery {
        session_id: Some(session_id.to_string()),
        include_live: Some(true),
        limit: Some(1),
        ..Default::default()
    };
    let page = query_sessions(db, &query)?;
    Ok(page.items.into_iter().next())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn memdb() -> Db {
        Db::open_in_memory().expect("内存库")
    }

    fn insert_source(conn: &rusqlite::Connection, id: &str, hidden: bool) -> AppResult<()> {
        let now = "2026-01-01T00:00:00+00:00";
        conn.execute(
            "INSERT OR IGNORE INTO agent_sources
               (id, display_name, kind, enabled, verified, homepage, note, config,
                created_at, updated_at, hidden)
             VALUES (?1, ?2, 'manual', 1, 0, '', '', '{}', ?3, ?3, ?4)",
            rusqlite::params![id, id, now, hidden as i64],
        )?;
        Ok(())
    }

    #[test]
    fn ipc_query_deserializes_frontend_camel_case() {
        // IPC 契约：前端按 camelCase 传 query，Rust 侧必须一一映射；
        // 缺省字段（未筛选）应为 None，不得误当成空字符串过滤。
        let query: AgentSessionHistoryQuery = serde_json::from_str(
            r#"{"sourceId":"codex","instanceId":"inst-1","unassigned":false,
                "status":"running","keyword":"支付","sessionId":"sess-1",
                "cursor":"opaque","limit":10}"#,
        )
        .unwrap();
        assert_eq!(query.source_id.as_deref(), Some("codex"));
        assert_eq!(query.instance_id.as_deref(), Some("inst-1"));
        assert_eq!(query.unassigned, Some(false));
        assert_eq!(query.status.as_deref(), Some("running"));
        assert_eq!(query.keyword.as_deref(), Some("支付"));
        assert_eq!(query.session_id.as_deref(), Some("sess-1"));
        assert_eq!(query.cursor.as_deref(), Some("opaque"));
        assert_eq!(query.limit, Some(10));

        let empty: AgentSessionHistoryQuery = serde_json::from_str("{}").unwrap();
        assert!(empty.source_id.is_none());
        assert!(empty.instance_id.is_none());
        assert!(empty.keyword.is_none());
        assert!(empty.cursor.is_none());
        assert!(empty.limit.is_none());
    }

    /// 在调用方事务内插入一个真实来源会话。
    fn insert_session(
        conn: &rusqlite::Connection,
        id: &str,
        source_id: &str,
        instance_id: Option<&str>,
        status: &str,
        last_seen_at: &str,
        title: &str,
        external_id: &str,
    ) -> AppResult<()> {
        conn.execute(
            "INSERT INTO agent_sessions
               (id, source_id, external_id, title, status, first_seen_at, last_seen_at,
                last_run_id, instance_id, origin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL, ?7, 'real')",
            rusqlite::params![
                id,
                source_id,
                external_id,
                title,
                status,
                last_seen_at,
                instance_id
            ],
        )?;
        Ok(())
    }

    fn insert_instance(
        conn: &rusqlite::Connection,
        id: &str,
        source_id: &str,
        key: &str,
        at: &str,
    ) -> AppResult<()> {
        conn.execute(
            "INSERT INTO agent_instances
               (id, source_id, instance_key, display_name, exe_path, first_seen_at, last_seen_at, origin)
             VALUES (?1, ?2, ?3, ?3, '', ?4, ?4, 'real')",
            rusqlite::params![id, source_id, key, at],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_run(
        conn: &rusqlite::Connection,
        id: &str,
        session_id: &str,
        source_id: &str,
        task_title: &str,
        status: &str,
        updated_at: &str,
    ) -> AppResult<()> {
        conn.execute(
            "INSERT INTO agent_runs
               (id, session_id, source_id, external_run_id, task_title, status,
                started_at, updated_at, ended_at, pending_items, instance_id, origin)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?6, NULL, '[]', NULL, 'real')",
            rusqlite::params![id, session_id, source_id, task_title, status, updated_at],
        )?;
        Ok(())
    }

    /// 插入 `count` 个会话（单事务 + 预编译语句，10k 规模也保持毫秒级）。
    /// `last_seen_at` 严格递增，保证排序确定；i 越大越新。
    fn seed_sessions(db: &Db, count: usize, source_id: &str) -> Vec<String> {
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let mut stmt = tx.prepare(
                "INSERT INTO agent_sessions
                   (id, source_id, external_id, title, status, first_seen_at, last_seen_at,
                    last_run_id, instance_id, origin)
                 VALUES (?1, ?2, ?3, ?4, 'idle', ?5, ?5, NULL, NULL, 'real')",
            )?;
            let mut ids = Vec::with_capacity(count);
            for i in 0..count {
                let id = format!("sess-{i:06}");
                // 固定 UTC 时区 + 严格递增秒，字符串排序 = 时间排序。
                let ts =
                    chrono::DateTime::<chrono::Utc>::from_timestamp(1_767_225_600 + i as i64, 0)
                        .expect("合法时间戳")
                        .to_rfc3339();
                stmt.execute(rusqlite::params![
                    id,
                    source_id,
                    format!("ext-{i:06}"),
                    format!("会话 {i}"),
                    ts
                ])?;
                ids.push(id);
            }
            drop(stmt);
            tx.commit()?;
            Ok::<_, AppError>(ids)
        })
        .unwrap()
    }

    fn collect_all_sessions(
        db: &Db,
        source_id: &str,
        page: i64,
    ) -> (Vec<AgentHistorySession>, i64) {
        let mut all = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        loop {
            let query = AgentSessionHistoryQuery {
                source_id: Some(source_id.into()),
                cursor: cursor.clone(),
                limit: Some(page),
                ..Default::default()
            };
            let out = query_sessions(db, &query).unwrap();
            assert!(out.total >= out.items.len() as i64);
            all.extend(out.items);
            pages += 1;
            assert!(pages < 10_000, "游标分页不得无限循环");
            match out.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        (all, pages)
    }

    #[test]
    fn history_and_groups_exclude_live_sessions_using_run_semantics() {
        use chrono::Duration;
        let db = memdb();
        let now = chrono::Utc::now().to_rfc3339();
        let old = (chrono::Utc::now() - Duration::hours(2)).to_rfc3339();
        db.with_conn(|conn| {
            insert_source(conn, "codex", false)?;
            insert_instance(conn, "inst-old", "codex", "old-instance", &now)?;
            // 实时：running / waiting / 近期 failed
            for (sid, status) in [
                ("s-running", "running"),
                ("s-waiting", "waiting"),
                ("s-failed-recent", "failed"),
            ] {
                insert_session(conn, sid, "codex", None, status, &now, sid, sid)?;
                insert_run(conn, &format!("{sid}-run"), sid, "codex", sid, status, &now)?;
            }
            // 历史：过期 failed / completed / 无轮次 / 有真实实例但快照可能没有
            insert_session(conn, "s-failed-old", "codex", None, "failed", &old, "旧失败", "s-failed-old")?;
            insert_run(conn, "s-failed-old-run", "s-failed-old", "codex", "旧失败", "failed", &old)?;
            insert_session(conn, "s-completed", "codex", None, "completed", &now, "已完成", "s-completed")?;
            insert_run(conn, "s-completed-run", "s-completed", "codex", "已完成", "completed", &now)?;
            insert_session(conn, "s-norun", "codex", None, "idle", &old, "无轮次", "s-norun")?;
            insert_session(conn, "s-inst", "codex", Some("inst-old"), "completed", &old, "实例历史", "s-inst")?;
            insert_run(conn, "s-inst-run", "s-inst", "codex", "实例历史", "completed", &old)?;
            // 隐藏来源：历史入口不应出现
            insert_source(conn, "hidden-src", true)?;
            insert_session(conn, "s-hidden", "hidden-src", None, "completed", &old, "隐藏来源", "s-hidden")?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let page = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                limit: Some(100),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 4, "历史 COUNT 必须排除实时会话：{:?}", page.items);
        let ids: std::collections::HashSet<_> = page.items.iter().map(|s| s.id.clone()).collect();
        for live in ["s-running", "s-waiting", "s-failed-recent"] {
            assert!(!ids.contains(live), "实时会话不得出现在历史列表: {live}");
        }
        for hist in ["s-failed-old", "s-completed", "s-norun", "s-inst"] {
            assert!(ids.contains(hist), "历史会话必须可访问: {hist}");
        }
        assert!(!ids.contains("s-hidden"), "隐藏来源不得出现在历史列表");

        let all = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                include_live: Some(true),
                limit: Some(100),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(all.total, 7, "includeLive 包含实时+历史，但隐藏来源仍排除");

        // 精确定位可命中实时会话（通知可能指向运行中的轮次）。
        assert!(find_session(&db, "s-running").unwrap().is_some());

        let groups = query_groups(
            &db,
            &AgentHistoryGroupQuery {
                source_id: Some("codex".into()),
                include_live: None,
            },
        )
        .unwrap();
        let unassigned = groups
            .items
            .iter()
            .find(|g| g.instance_id.is_none())
            .expect("未关联历史分组");
        assert_eq!(unassigned.count, 3);
        let inst = groups
            .items
            .iter()
            .find(|g| g.instance_id.as_deref() == Some("inst-old"))
            .expect("历史实例分组");
        assert_eq!(inst.count, 1);
        assert_eq!(inst.instance_key.as_deref(), Some("old-instance"));
        assert!(!groups.items.iter().any(|g| g.source_id == "hidden-src"));
    }

    #[test]
    fn history_first_page_is_not_empty_when_live_sessions_precede_history() {
        use chrono::Duration;
        let db = memdb();
        let now = chrono::Utc::now().to_rfc3339();
        let old = (chrono::Utc::now() - Duration::hours(2)).to_rfc3339();
        db.with_conn(|conn| {
            insert_source(conn, "codex", false)?;
            for i in 0..5 {
                let sid = format!("live-{i}");
                insert_session(conn, &sid, "codex", None, "running", &now, &sid, &sid)?;
                insert_run(conn, &format!("{sid}-run"), &sid, "codex", &sid, "running", &now)?;
            }
            for i in 0..5 {
                let sid = format!("hist-{i}");
                insert_session(conn, &sid, "codex", None, "completed", &old, &sid, &sid)?;
                insert_run(conn, &format!("{sid}-run"), &sid, "codex", &sid, "completed", &old)?;
            }
            Ok::<_, AppError>(())
        })
        .unwrap();

        let page = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 5, "total 只算历史");
        assert_eq!(page.items.len(), 2, "第一页不能被实时会话过滤成空");
        assert!(page.items.iter().all(|s| s.id.starts_with("hist-")));
        assert_eq!(
            page.items.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
            vec!["hist-4".to_string(), "hist-3".to_string()]
        );
    }

    #[test]
    fn all_live_sessions_yield_empty_history_and_groups_but_remain_locatable() {
        let db = memdb();
        let now = chrono::Utc::now().to_rfc3339();
        db.with_conn(|conn| {
            insert_source(conn, "codex", false)?;
            for i in 0..3 {
                let sid = format!("live-{i}");
                insert_session(conn, &sid, "codex", None, "running", &now, &sid, &sid)?;
                insert_run(conn, &format!("{sid}-run"), &sid, "codex", &sid, "running", &now)?;
            }
            Ok::<_, AppError>(())
        })
        .unwrap();

        let page = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 0, "全实时时历史总数必须为 0");
        assert!(page.items.is_empty(), "全实时时历史第一页必须为空");
        assert!(page.next_cursor.is_none());

        let groups = query_groups(
            &db,
            &AgentHistoryGroupQuery {
                source_id: Some("codex".into()),
                include_live: None,
            },
        )
        .unwrap();
        assert!(groups.items.is_empty(), "全实时时不得补出历史入口");
        assert!(!groups.truncated);

        let all = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                include_live: Some(true),
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(all.total, 3, "includeLive 仍可看到全部实时会话");
        assert!(find_session(&db, "live-0").unwrap().is_some(), "实时会话仍可按 ID 定位");
    }

    #[test]
    fn run_completion_moves_session_from_live_to_history_consistently() {
        let db = memdb();
        let now = chrono::Utc::now().to_rfc3339();
        db.with_conn(|conn| {
            insert_source(conn, "codex", false)?;
            insert_session(conn, "s1", "codex", None, "running", &now, "运行中", "s1")?;
            insert_run(conn, "r1", "s1", "codex", "运行中", "running", &now)?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let before = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(before.total, 0, "运行中的会话属于实时，不应进入历史");

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_runs SET status = 'completed', updated_at = ?1 WHERE id = 'r1'",
                rusqlite::params![now],
            )?;
            conn.execute(
                "UPDATE agent_sessions SET status = 'completed' WHERE id = 's1'",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let after = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(after.total, 1, "轮次完成后会话必须转入历史");
        assert_eq!(after.items.len(), 1);
        assert_eq!(after.items[0].id, "s1");

        let groups = query_groups(
            &db,
            &AgentHistoryGroupQuery {
                source_id: Some("codex".into()),
                include_live: None,
            },
        )
        .unwrap();
        assert_eq!(groups.items.iter().map(|g| g.count).sum::<i64>(), 1);
    }

    #[test]
    fn expired_disconnected_run_becomes_history_and_active_run_returns_to_live() {
        use chrono::Duration;
        let db = memdb();
        let now = chrono::Utc::now().to_rfc3339();
        let old = (chrono::Utc::now() - Duration::hours(2)).to_rfc3339();
        db.with_conn(|conn| {
            insert_source(conn, "codex", false)?;
            insert_session(conn, "s2", "codex", None, "failed", &old, "断连", "s2")?;
            insert_run(conn, "r2", "s2", "codex", "断连", "failed", &old)?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let before = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(before.total, 1, "超过 1 小时的 failed 视作历史");

        // 同一轮次重新活跃：历史应立即排除，实时查询仍可见。
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_runs SET status = 'running', updated_at = ?1 WHERE id = 'r2'",
                rusqlite::params![now],
            )?;
            conn.execute(
                "UPDATE agent_sessions SET status = 'running', last_seen_at = ?1 WHERE id = 's2'",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let after = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(after.total, 0, "断连转活跃后不得继续留在历史");
        let all = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                include_live: Some(true),
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(all.total, 1, "includeLive 仍能看到重新活跃的会话");
        assert!(find_session(&db, "s2").unwrap().is_some());
    }

    #[test]
    fn live_transition_between_pages_does_not_duplicate_items() {
        let db = memdb();
        let base = chrono::Utc::now();
        db.with_conn(|conn| {
            insert_source(conn, "codex", false)?;
            for i in 0..4 {
                let sid = format!("h{i}");
                let at = (base - chrono::Duration::minutes(10 - i)).to_rfc3339();
                insert_session(conn, &sid, "codex", None, "completed", &at, &sid, &sid)?;
                insert_run(conn, &format!("{sid}-run"), &sid, "codex", &sid, "completed", &at)?;
            }
            Ok::<_, AppError>(())
        })
        .unwrap();

        let first = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(first.total, 4);
        let first_ids: Vec<String> = first.items.iter().map(|s| s.id.clone()).collect();
        assert_eq!(first_ids, vec!["h3".to_string(), "h2".to_string()]);
        let cursor = first.next_cursor.expect("还有下一页");

        // 两次请求之间，尚未翻到的 h1 转为实时（模拟新运行开始）。
        let now = chrono::Utc::now().to_rfc3339();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_runs SET status = 'running', updated_at = ?1 WHERE id = 'h1-run'",
                rusqlite::params![now],
            )?;
            conn.execute(
                "UPDATE agent_sessions SET status = 'running' WHERE id = 'h1'",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let second = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                cursor: Some(cursor),
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(second.total, 3, "total 随实时/历史重分类更新");
        assert_eq!(
            second.items.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
            vec!["h0".to_string()],
            "已翻过的条目不得重复，仍在历史的条目不得遗漏"
        );
        assert!(!second.items.iter().any(|s| first_ids.contains(&s.id)));
    }

    #[test]
    fn groups_include_instances_outside_snapshot_and_dangling_as_unassigned() {
        let db = memdb();
        db.with_conn(|conn| {
            insert_source(conn, "codex", false)?;
            insert_instance(conn, "inst-deep", "codex", "deep-instance", "2026-01-02T00:00:00+00:00")?;
            insert_session(
                conn,
                "s-deep",
                "codex",
                Some("inst-deep"),
                "completed",
                "2026-01-02T00:00:00+00:00",
                "深层实例",
                "s-deep",
            )?;
            insert_session(
                conn,
                "s-dangling",
                "codex",
                Some("deleted-instance"),
                "completed",
                "2026-01-01T00:00:00+00:00",
                "悬空实例",
                "s-dangling",
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let groups = query_groups(&db, &AgentHistoryGroupQuery::default()).unwrap();
        let deep = groups
            .items
            .iter()
            .find(|g| g.instance_id.as_deref() == Some("inst-deep"))
            .expect("快照外实例也应有历史入口");
        assert_eq!(deep.count, 1);
        assert_eq!(deep.display_name.as_deref(), Some("deep-instance"));
        let dangling = groups
            .items
            .iter()
            .find(|g| g.instance_id.is_none())
            .expect("失效实例归入未关联实例");
        assert_eq!(dangling.count, 1);
        assert!(!groups.items.iter().any(|g| g.instance_id.as_deref() == Some("deleted-instance")));
    }

    #[test]
    fn empty_database_returns_zero_total_and_null_cursor() {
        let db = memdb();
        let out = query_sessions(&db, &AgentSessionHistoryQuery::default()).unwrap();
        assert!(out.items.is_empty());
        assert_eq!(out.total, 0);
        assert!(out.next_cursor.is_none());
    }

    #[test]
    fn ten_sessions_paginate_without_duplicates() {
        let db = memdb();
        let ids = seed_sessions(&db, 10, "codex");
        let (all, pages) = collect_all_sessions(&db, "codex", 3);
        assert_eq!(pages, 4, "10 条 / 每页 3 条 = 4 页");
        assert_eq!(all.len(), 10);
        let seen: std::collections::HashSet<_> = all.iter().map(|s| s.id.clone()).collect();
        assert_eq!(seen.len(), 10, "翻页不得重复");
        let expected: std::collections::HashSet<_> = ids.into_iter().collect();
        assert_eq!(seen, expected, "翻页不得丢项");
        // 新的在前：sess-000009 排第一。
        assert_eq!(all[0].id, "sess-000009");
        assert_eq!(all[9].id, "sess-000000");
    }

    #[test]
    fn two_hundred_sessions_count_and_full_pagination() {
        let db = memdb();
        seed_sessions(&db, 200, "codex");
        let first = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                limit: Some(50),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(first.total, 200);
        assert_eq!(first.items.len(), 50);
        assert!(first.next_cursor.is_some());

        let (all, pages) = collect_all_sessions(&db, "codex", 50);
        assert_eq!(all.len(), 200);
        assert_eq!(pages, 4);
        let seen: std::collections::HashSet<_> = all.iter().map(|s| s.id.clone()).collect();
        assert_eq!(seen.len(), 200);
    }

    #[test]
    fn two_hundred_one_sessions_reachable_beyond_snapshot_limit() {
        // 快照 LIMIT 200 的边界：第 201 条必须仍可翻到，且 total 准确。
        let db = memdb();
        seed_sessions(&db, 201, "codex");
        let (all, pages) = collect_all_sessions(&db, "codex", 100);
        assert_eq!(pages, 3);
        assert_eq!(all.len(), 201);
        assert!(all.iter().any(|s| s.id == "sess-000000"));
    }

    #[test]
    fn thousand_sessions_full_pagination_is_complete_and_stable() {
        let db = memdb();
        seed_sessions(&db, 1000, "codex");
        let (all, pages) = collect_all_sessions(&db, "codex", 100);
        assert_eq!(pages, 10);
        assert_eq!(all.len(), 1000);
        let seen: std::collections::HashSet<_> = all.iter().map(|s| s.id.clone()).collect();
        assert_eq!(seen.len(), 1000);
        // 稳定性：同一条件下重复翻页顺序一致。
        let (again, _) = collect_all_sessions(&db, "codex", 100);
        let order: Vec<_> = all.iter().map(|s| s.id.clone()).collect();
        let order_again: Vec<_> = again.iter().map(|s| s.id.clone()).collect();
        assert_eq!(order, order_again);
    }

    #[test]
    fn ten_thousand_sessions_count_and_pagination_complete() {
        let db = memdb();
        seed_sessions(&db, 10_000, "codex");
        let first = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                limit: Some(100),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(first.total, 10_000);
        assert_eq!(first.items.len(), 100);

        let (all, pages) = collect_all_sessions(&db, "codex", 100);
        assert_eq!(pages, 100);
        assert_eq!(all.len(), 10_000);
        let seen: std::collections::HashSet<_> = all.iter().map(|s| s.id.clone()).collect();
        assert_eq!(seen.len(), 10_000, "10k 规模翻页不得重复/丢失");
    }

    #[test]
    fn ten_thousand_first_and_deep_page_latency_is_measured() {
        use std::time::{Duration, Instant};
        let db = memdb();
        seed_sessions(&db, 10_000, "codex");

        let started = Instant::now();
        let mut page = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                limit: Some(100),
                ..Default::default()
            },
        )
        .unwrap();
        let first = started.elapsed();
        assert_eq!(page.total, 10_000);

        // 走到约第 50 页（5000 条之后）再计时：keyset 不应随深度线性变慢。
        for _ in 0..49 {
            let cursor = page.next_cursor.clone().expect("还有下一页");
            page = query_sessions(
                &db,
                &AgentSessionHistoryQuery {
                    source_id: Some("codex".into()),
                    cursor: Some(cursor),
                    limit: Some(100),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let cursor = page.next_cursor.clone().expect("还有下一页");
        let started = Instant::now();
        let deep = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                cursor: Some(cursor),
                limit: Some(100),
                ..Default::default()
            },
        )
        .unwrap();
        let deep_elapsed = started.elapsed();
        println!(
            "agent_history 10k: first_page={:?}, deep_page={:?}, total={}",
            first, deep_elapsed, deep.total
        );
        // 宽松上限只用于捕获病理性退化；真实数值记录在验收报告。
        assert!(
            first < Duration::from_secs(2),
            "first page too slow: {first:?}"
        );
        assert!(
            deep_elapsed < Duration::from_secs(2),
            "deep page too slow: {deep_elapsed:?}"
        );
    }

    #[test]
    fn ten_thousand_like_search_and_fifty_instance_groups_latency_is_measured() {
        use std::time::{Duration, Instant};
        let db = memdb();
        db.with_conn(|conn| {
            insert_source(conn, "codex", false)?;
            let tx = conn.unchecked_transaction()?;
            for i in 0..50 {
                insert_instance(
                    &tx,
                    &format!("inst-{i:02}"),
                    "codex",
                    &format!("instance-{i:02}"),
                    "2026-01-01T00:00:00+00:00",
                )?;
            }
            for i in 0..10_000 {
                let id = format!("perf-{i:05}");
                insert_session(
                    &tx,
                    &id,
                    "codex",
                    Some(&format!("inst-{:02}", i % 50)),
                    "completed",
                    "2026-01-01T00:00:00+00:00",
                    &format!("性能会话 {i}"),
                    &id,
                )?;
            }
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let started = Instant::now();
        let like = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                keyword: Some("性能会话".into()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        let like_elapsed = started.elapsed();
        assert_eq!(like.total, 10_000);
        assert_eq!(like.items.len(), 10);

        let started = Instant::now();
        let groups = query_groups(
            &db,
            &AgentHistoryGroupQuery {
                source_id: Some("codex".into()),
                include_live: None,
            },
        )
        .unwrap();
        let groups_elapsed = started.elapsed();
        assert_eq!(groups.items.len(), 50);
        assert_eq!(groups.items.iter().map(|g| g.count).sum::<i64>(), 10_000);
        println!(
            "agent_history 10k/50inst: like_page={:?}, groups={:?}",
            like_elapsed, groups_elapsed
        );
        assert!(
            like_elapsed < Duration::from_secs(2),
            "LIKE search too slow: {like_elapsed:?}"
        );
        assert!(
            groups_elapsed < Duration::from_secs(2),
            "groups query too slow: {groups_elapsed:?}"
        );
    }

    #[test]
    fn identical_timestamps_tie_break_by_id_and_never_repeat() {
        let db = memdb();
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            for i in 0..50 {
                insert_session(
                    &tx,
                    &format!("same-{i:03}"),
                    "codex",
                    None,
                    "idle",
                    "2026-01-01T00:00:00+00:00",
                    &format!("同刻会话 {i}"),
                    &format!("ext-same-{i:03}"),
                )?;
            }
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let mut seen = std::collections::HashSet::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = query_sessions(
                &db,
                &AgentSessionHistoryQuery {
                    source_id: Some("codex".into()),
                    cursor: cursor.clone(),
                    limit: Some(7),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(page.total, 50);
            for item in &page.items {
                assert!(seen.insert(item.id.clone()), "同时间戳游标重复返回");
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(seen.len(), 50);
    }

    #[test]
    fn keyword_matches_title_external_id_and_run_task_title() {
        let db = memdb();
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            insert_session(
                &tx,
                "s-title",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:01+00:00",
                "修复登录",
                "ext-a",
            )?;
            insert_session(
                &tx,
                "s-ext",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:02+00:00",
                "无关标题",
                "EXT-42",
            )?;
            insert_session(
                &tx,
                "s-run",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:03+00:00",
                "另一个会话",
                "ext-b",
            )?;
            insert_session(
                &tx,
                "s-other",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:04+00:00",
                "支付页面",
                "ext-c",
            )?;
            insert_run(
                &tx,
                "r1",
                "s-run",
                "codex",
                "重构支付模块",
                "completed",
                "2026-01-01T00:00:05+00:00",
            )?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let search = |kw: &str| {
            query_sessions(
                &db,
                &AgentSessionHistoryQuery {
                    keyword: Some(kw.into()),
                    ..Default::default()
                },
            )
            .unwrap()
        };
        assert_eq!(search("登录").total, 1);
        assert_eq!(search("登录").items[0].id, "s-title");
        assert_eq!(search("ext-42").total, 1, "external_id 不区分 ASCII 大小写");
        assert_eq!(search("ext-42").items[0].id, "s-ext");
        let by_run = search("重构");
        assert_eq!(by_run.total, 1, "关联轮次任务标题也应命中");
        assert_eq!(by_run.items[0].id, "s-run");
        assert_eq!(search("支付").total, 2, "标题与轮次标题都命中的会话都返回");
    }

    #[test]
    fn keyword_wildcards_are_literal() {
        let db = memdb();
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            insert_session(
                &tx,
                "s1",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:01+00:00",
                "进度 100% 完成",
                "ext-1",
            )?;
            insert_session(
                &tx,
                "s2",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:02+00:00",
                "进度 1000 完成",
                "ext-2",
            )?;
            insert_session(
                &tx,
                "s3",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:03+00:00",
                "a_b",
                "ext-3",
            )?;
            insert_session(
                &tx,
                "s4",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:04+00:00",
                "axb",
                "ext-4",
            )?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let percent = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                keyword: Some("100%".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(percent.total, 1, "%% 必须按字面量处理");
        assert_eq!(percent.items[0].id, "s1");

        let underscore = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                keyword: Some("a_b".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(underscore.total, 1, "_ 必须按字面量处理");
        assert_eq!(underscore.items[0].id, "s3");
    }

    #[test]
    fn filters_by_source_instance_status_and_unassigned() {
        let db = memdb();
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            insert_instance(&tx, "inst-a", "codex", "a", "2026-01-01T00:00:00+00:00")?;
            insert_instance(&tx, "inst-b", "codex", "b", "2026-01-01T00:00:00+00:00")?;
            insert_session(
                &tx,
                "c-a-run",
                "codex",
                Some("inst-a"),
                "running",
                "2026-01-01T00:00:10+00:00",
                "A 运行",
                "ea",
            )?;
            insert_session(
                &tx,
                "c-a-idle",
                "codex",
                Some("inst-a"),
                "idle",
                "2026-01-01T00:00:09+00:00",
                "A 空闲",
                "eb",
            )?;
            insert_session(
                &tx,
                "c-b",
                "codex",
                Some("inst-b"),
                "idle",
                "2026-01-01T00:00:08+00:00",
                "B 空闲",
                "ec",
            )?;
            insert_session(
                &tx,
                "c-none",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:07+00:00",
                "未关联",
                "ed",
            )?;
            insert_session(
                &tx,
                "c-dangling",
                "codex",
                Some("inst-gone"),
                "idle",
                "2026-01-01T00:00:06+00:00",
                "悬空实例",
                "ee",
            )?;
            insert_session(
                &tx,
                "t-a",
                "trae",
                None,
                "waiting",
                "2026-01-01T00:00:11+00:00",
                "Trae 等待",
                "et",
            )?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let by_source = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("trae".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_source.total, 1);
        assert_eq!(by_source.items[0].id, "t-a");

        let by_instance = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                instance_id: Some("inst-a".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_instance.total, 2);
        assert!(by_instance
            .items
            .iter()
            .all(|s| s.instance_id.as_deref() == Some("inst-a")));

        let unassigned = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                unassigned: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(unassigned.total, 2, "NULL 与悬空实例都算未关联");
        let ids: std::collections::HashSet<_> =
            unassigned.items.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains("c-none"));
        assert!(ids.contains("c-dangling"));
        assert_eq!(
            unassigned
                .items
                .iter()
                .find(|s| s.id == "c-dangling")
                .and_then(|s| s.instance_id.as_deref()),
            None,
            "悬空实例在 DTO 中归一为未关联，定位时不会指向不存在的实例"
        );

        let running = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                status: Some("working".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(running.total, 1);
        assert_eq!(running.items[0].id, "c-a-run");

        let combo = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                instance_id: Some("inst-a".into()),
                status: Some("idle".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(combo.total, 1);
        assert_eq!(combo.items[0].id, "c-a-idle");
    }

    #[test]
    fn run_count_is_accurate_per_session() {
        let db = memdb();
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            insert_session(
                &tx,
                "s1",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:01+00:00",
                "多轮",
                "e1",
            )?;
            insert_session(
                &tx,
                "s2",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:02+00:00",
                "无轮次",
                "e2",
            )?;
            insert_run(
                &tx,
                "r1",
                "s1",
                "codex",
                "任务一",
                "completed",
                "2026-01-01T00:00:03+00:00",
            )?;
            insert_run(
                &tx,
                "r2",
                "s1",
                "codex",
                "任务二",
                "completed",
                "2026-01-01T00:00:04+00:00",
            )?;
            insert_run(
                &tx,
                "r3",
                "s1",
                "codex",
                "任务三",
                "completed",
                "2026-01-01T00:00:05+00:00",
            )?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let page = query_sessions(&db, &AgentSessionHistoryQuery::default()).unwrap();
        assert_eq!(page.total, 2);
        let by_id: std::collections::HashMap<_, _> = page
            .items
            .iter()
            .map(|s| (s.id.as_str(), s.run_count))
            .collect();
        assert_eq!(by_id["s1"], 3);
        assert_eq!(by_id["s2"], 0);
    }

    #[test]
    fn locate_session_by_id_without_cursor() {
        let db = memdb();
        seed_sessions(&db, 30, "codex");
        let page = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                session_id: Some("sess-000003".into()),
                // 伪造游标也应被忽略（精确查找不使用游标）
                cursor: Some("not-a-cursor".into()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "sess-000003");
        assert!(page.next_cursor.is_none());

        let missing = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                session_id: Some("不存在".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(missing.total, 0);
        assert!(missing.items.is_empty());
        assert!(find_session(&db, "sess-000003").unwrap().is_some());
        assert!(find_session(&db, "missing").unwrap().is_none());
    }

    #[test]
    fn cursor_boundary_at_last_item_returns_empty_page() {
        let db = memdb();
        seed_sessions(&db, 10, "codex");
        let mut cursor: Option<String> = None;
        let mut last_id = String::new();
        loop {
            let page = query_sessions(
                &db,
                &AgentSessionHistoryQuery {
                    source_id: Some("codex".into()),
                    cursor: cursor.clone(),
                    limit: Some(5),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(page.total, 10);
            if page.items.is_empty() {
                break;
            }
            last_id = page.items.last().unwrap().id.clone();
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(last_id, "sess-000000", "最后一条必须是最旧会话");
        // 用最后一条的游标再翻一页：空页、total 仍准确、next_cursor 为 null。
        let last_item = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                session_id: Some(last_id.clone()),
                ..Default::default()
            },
        )
        .unwrap()
        .items
        .remove(0);
        let cursor = encode_cursor(&HistoryCursor {
            v: CURSOR_VERSION,
            last_seen_at: last_item.last_seen_at,
            id: last_item.id,
        })
        .unwrap();
        let empty = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                cursor: Some(cursor),
                limit: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(empty.items.is_empty());
        assert_eq!(empty.total, 10);
        assert!(empty.next_cursor.is_none());
    }

    #[test]
    fn invalid_cursor_is_rejected_instead_of_silently_reordering() {
        let db = memdb();
        seed_sessions(&db, 3, "codex");
        let err = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                cursor: Some("{\"v\":1}".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn new_inserts_between_pages_do_not_duplicate_or_lose_rows() {
        let db = memdb();
        seed_sessions(&db, 10, "codex");
        let page1 = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                limit: Some(3),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page1.items.len(), 3);

        // 翻页期间新插入更新的会话（应落在游标之前，不出现在后续页）
        db.with_conn(|conn| {
            insert_session(
                conn,
                "sess-newest",
                "codex",
                None,
                "idle",
                "2026-01-02T00:00:00+00:00",
                "最新会话",
                "ext-newest",
            )
        })
        .unwrap();

        let mut all = page1.items.clone();
        let mut total = page1.total;
        let mut cursor = page1.next_cursor;
        while let Some(c) = cursor {
            let page = query_sessions(
                &db,
                &AgentSessionHistoryQuery {
                    source_id: Some("codex".into()),
                    cursor: Some(c),
                    limit: Some(3),
                    ..Default::default()
                },
            )
            .unwrap();
            total = page.total;
            all.extend(page.items);
            cursor = page.next_cursor;
        }
        assert_eq!(total, 11, "总数反映新插入");
        assert_eq!(
            all.len(),
            10,
            "已加载页 + 后续页共 10 条（新记录在游标之前）"
        );
        let seen: std::collections::HashSet<_> = all.iter().map(|s| s.id.clone()).collect();
        assert_eq!(seen.len(), all.len(), "不得重复");
        assert!(!all.iter().any(|s| s.id == "sess-newest"));

        // 再补充一次：新插入一条更旧的记录，后续翻页应能包含它。
        db.with_conn(|conn| {
            insert_session(
                conn,
                "sess-oldest",
                "codex",
                None,
                "idle",
                "2025-12-31T00:00:00+00:00",
                "更旧会话",
                "ext-oldest",
            )
        })
        .unwrap();
        let tail = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                source_id: Some("codex".into()),
                cursor: Some(
                    encode_cursor(&HistoryCursor {
                        v: CURSOR_VERSION,
                        last_seen_at: all.last().unwrap().last_seen_at.clone(),
                        id: all.last().unwrap().id.clone(),
                    })
                    .unwrap(),
                ),
                limit: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(tail.total, 12);
        assert!(tail.items.iter().any(|s| s.id == "sess-oldest"));
    }

    #[test]
    fn runs_paginate_with_total_and_stable_order() {
        let db = memdb();
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            insert_session(
                &tx,
                "s1",
                "codex",
                None,
                "idle",
                "2026-01-01T00:00:00+00:00",
                "会话",
                "e1",
            )?;
            for i in 0..25 {
                insert_run(
                    &tx,
                    &format!("run-{i:03}"),
                    "s1",
                    "codex",
                    &format!("任务 {i}"),
                    "completed",
                    &format!("2026-01-01T00:01:{:02}.{:06}+00:00", i % 60, i),
                )?;
            }
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let mut seen = std::collections::HashSet::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        let mut all_order = Vec::new();
        loop {
            let page = query_runs(&db, "s1", cursor.as_deref(), Some(10), None).unwrap();
            assert_eq!(page.total, 25);
            pages += 1;
            for run in &page.items {
                assert!(seen.insert(run.id.clone()), "轮次游标重复");
                all_order.push(run.id.clone());
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(pages, 3);
        assert_eq!(seen.len(), 25);
        assert_eq!(all_order[0], "run-024", "最新更新的轮次在前");
        assert_eq!(all_order.last().unwrap(), "run-000");

        let empty = query_runs(&db, "missing-session", None, Some(10), None).unwrap();
        assert_eq!(empty.total, 0);
        assert!(empty.items.is_empty());
        assert!(empty.next_cursor.is_none());

        let err = query_runs(&db, "s1", Some("bad-cursor"), Some(10), None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn runs_history_excludes_live_runs_and_total_matches_page() {
        let db = memdb();
        let now = chrono::Utc::now().to_rfc3339();
        let old = (chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
        db.with_conn(|conn| {
            insert_source(conn, "codex", false)?;
            insert_session(conn, "s1", "codex", None, "running", &now, "混合会话", "s1")?;
            insert_run(conn, "r-live", "s1", "codex", "运行中", "running", &now)?;
            insert_run(conn, "r-waiting", "s1", "codex", "等待", "waiting", &now)?;
            insert_run(conn, "r-failed-old", "s1", "codex", "旧失败", "failed", &old)?;
            insert_run(conn, "r-completed", "s1", "codex", "已完成", "completed", &now)?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let page = query_runs(&db, "s1", None, Some(10), None).unwrap();
        assert_eq!(page.total, 2, "历史轮次 COUNT 不得包含实时轮次");
        assert_eq!(
            page.items.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["r-completed", "r-failed-old"],
            "实时轮次由快照渲染，历史分区只列已结束轮次"
        );
        assert!(page.next_cursor.is_none());

        let all = query_runs(&db, "s1", None, Some(10), Some(true)).unwrap();
        assert_eq!(all.total, 4, "include_live=true 仍可查看完整轮次");
        assert_eq!(all.items.len(), 4);
    }

    #[test]
    fn limit_is_clamped_and_bad_keyword_is_rejected() {
        let db = memdb();
        seed_sessions(&db, 120, "codex");
        let zero = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                limit: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(zero.items.len(), 1);
        let huge = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                limit: Some(10_000),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(huge.items.len(), MAX_LIMIT as usize);
        assert_eq!(huge.total, 120);

        let err = query_sessions(
            &db,
            &AgentSessionHistoryQuery {
                keyword: Some("x".repeat(MAX_KEYWORD_LEN + 1)),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
