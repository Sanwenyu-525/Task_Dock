//! Agent 工作时间统计（按需聚合，不建第二套监控、不写回原始运行状态）。
//!
//! ## 语义
//! - **总运行跨度**：轮次首个已受理事件到终态/最后事件的墙钟跨度（跨窗口裁剪）。
//! - **执行时长**：只有可靠 `running` 事件区间（observed 证据、置信度达标、
//!   相邻事件间隔 ≤ 4h）才计入；其余一律「未知」。
//! - **等待时长**：`waiting` 状态区间（权限请求/输入/通知等待统一映射为 waiting）。
//! - **失败率** = 可靠 failed 轮次数 / (可靠 completed + 可靠 failed)。运行中、
//!   已断开、无可靠终态事件的轮次都不进分母，单独显示「未确认」。
//! - **来源隔离**：默认 `origin = real`；mock/benchmark/selftest/manual 必须显式切换。
//!
//! ## 数据来源与归属
//! 现有 Hook 适配器多数不提供 `run_id`，轮次事件在 `agent_events.run_external_id`
//! 为 NULL。对这类轮次按「会话内时间窗」（started_at 到下一轮 started_at）归属事件，
//! 并在结果里标注 `window_attributed`，绝不当作精确归属。
//!
//! ## 性能
//! 一次查询只做：1 次来源列表、1 次轮次列表（带时间范围 + 上限）、按来源 1~N 次
//! 事件查询（带 run_id/会话 IN 过滤、时间范围、事件上限、受理序号排序）。
//! 不在每个事件到达时重算；所有结果缓存由调用方按需刷新。

pub mod timeline;

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{DateTime, Datelike, TimeZone, Utc};
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use timeline::{analyze_run, RawEvent, RunInput, SliceKind, Terminal};

/// 允许查询的最大时间跨度（天）。
const MAX_RANGE_DAYS: i64 = 366;
const DEFAULT_MAX_RUNS: u32 = 5_000;
const HARD_MAX_RUNS: u32 = 20_000;
/// 单次查询最多载入的事件行数（超出即标记截断，绝不静默丢数据）。
const MAX_EVENTS: usize = 150_000;
/// 事件回看的额外余量：保证跨窗口轮次在窗口起点前的最后状态可见。
const EVENT_LOOKBACK_MS: i64 = 6 * 3600 * 1000;
const DEFAULT_SESSION_LIMIT: u32 = 20;
const MAX_SESSION_LIMIT: u32 = 100;
/// occurred_at 缺失、用 received_at 兜底的事件标记（时间不可靠，不计入时长）。
const RECEIVED_FALLBACK: &str = "received_fallback";

#[derive(Debug, Clone, Deserialize)]
pub struct WorkTimeStatsQuery {
    /// 统计起点（RFC3339，含）
    pub from: String,
    /// 统计终点（RFC3339，不含）
    pub to: String,
    /// real | selftest | benchmark | mock | manual（默认 real）
    #[serde(default)]
    pub origin: Option<String>,
    /// 只看单个来源（可选）
    #[serde(default)]
    pub source_id: Option<String>,
    /// day | week | month（默认 day）
    #[serde(default)]
    pub bucket: Option<String>,
    /// 前端本地时区偏移（分钟）；用于按本地日历分桶
    #[serde(default)]
    pub timezone_offset_minutes: Option<i32>,
    #[serde(default)]
    pub session_limit: Option<u32>,
    #[serde(default)]
    pub max_runs: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatsRange {
    pub from: String,
    pub to: String,
    pub origin: String,
    pub source_id: Option<String>,
    pub bucket: String,
    pub timezone_offset_minutes: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatsCoverage {
    /// 范围内符合条件的轮次总数（不受上限影响）
    pub runs_in_range: u32,
    /// 本次实际分析的轮次数
    pub runs_analyzed: u32,
    pub run_limit: u32,
    pub runs_truncated: bool,
    pub events_loaded: u32,
    pub event_limit: u32,
    pub events_truncated: bool,
    pub sessions_total: u32,
    pub sessions_shown: u32,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct StatsTotals {
    pub runs: u32,
    pub runs_with_detail: u32,
    pub runs_without_detail: u32,
    pub completed: u32,
    pub failed: u32,
    pub interrupted: u32,
    pub unresolved: u32,
    pub unverified_terminal: u32,
    /// None = 没有可靠终态，无法计算
    pub failure_rate: Option<f64>,
    pub span_sec: i64,
    pub exec_sec: i64,
    pub wait_sec: i64,
    pub idle_sec: i64,
    pub unknown_sec: i64,
    /// 未关闭尾部（进行中但无事件确认），不计入执行/等待
    pub open_tail_sec: i64,
    pub estimated_runs: u32,
    pub window_attributed_runs: u32,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct StatsQuality {
    pub missing_start_runs: u32,
    pub missing_end_runs: u32,
    pub stale_open_runs: u32,
    pub late_events: u32,
    pub unknown_timestamp_events: u32,
    pub coalesced_events: u32,
    pub unreliable_intervals: u32,
    pub gap_unknown_sec: i64,
    pub no_detail_runs: u32,
    pub window_attributed_runs: u32,
    /// 无法归属到任何轮次的会话事件数
    pub unattributed_events: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceStats {
    pub source_id: String,
    pub display_name: String,
    pub runs: u32,
    /// 该来源中没有可用事件明细的轮次数（执行/等待不可测量）
    pub runs_without_detail: u32,
    pub completed: u32,
    pub failed: u32,
    pub unresolved: u32,
    pub failure_rate: Option<f64>,
    pub span_sec: i64,
    pub exec_sec: i64,
    pub wait_sec: i64,
    pub unknown_sec: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionStats {
    pub session_id: String,
    pub source_id: String,
    pub source_name: String,
    pub external_id: String,
    pub title: String,
    pub status: String,
    pub last_seen_at: String,
    pub runs: u32,
    /// 该会话中没有可用事件明细的轮次数（执行/等待不可测量）
    pub runs_without_detail: u32,
    pub completed: u32,
    pub failed: u32,
    pub unresolved: u32,
    pub span_sec: i64,
    pub exec_sec: i64,
    pub wait_sec: i64,
    pub open_tail_sec: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrendPoint {
    pub bucket: String,
    pub start_at: String,
    pub runs: u32,
    pub completed: u32,
    pub failed: u32,
    pub exec_sec: i64,
    pub wait_sec: i64,
    pub unknown_sec: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceOption {
    pub id: String,
    pub display_name: String,
    pub category: String,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkTimeStats {
    pub generated_at: String,
    pub range: StatsRange,
    pub coverage: StatsCoverage,
    pub totals: StatsTotals,
    pub by_source: Vec<SourceStats>,
    pub sessions: Vec<SessionStats>,
    pub trend: Vec<TrendPoint>,
    pub quality: StatsQuality,
    pub available_sources: Vec<SourceOption>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Bucket {
    Day,
    Week,
    Month,
}

impl Bucket {
    fn parse(s: &str) -> AppResult<Self> {
        match s {
            "day" => Ok(Bucket::Day),
            "week" => Ok(Bucket::Week),
            "month" => Ok(Bucket::Month),
            _ => Err(AppError::Validation("bucket 只支持 day/week/month".into())),
        }
    }
}

struct RunRow {
    session_id: String,
    source_id: String,
    external_run_id: Option<String>,
    status: String,
    started_at: String,
    ended_at: Option<String>,
    last_event_at: String,
    updated_at: String,
    session_external_id: String,
    session_title: String,
    session_status: String,
    session_last_seen_at: String,
}

fn parse_ms(s: &str) -> Option<i64> {
    if s.is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn secs(ms: i64) -> i64 {
    ms / 1000
}

/// 把一段区间按「本地自然日」切分，返回 (本地日零点的毫秒键, 该段时长毫秒)。
fn split_by_local_day(start_ms: i64, end_ms: i64, offset_minutes: i32) -> Vec<(i64, i64)> {
    let offset_ms = offset_minutes as i64 * 60_000;
    let day_ms = 86_400_000i64;
    let mut out = Vec::new();
    let mut cur = start_ms;
    while cur < end_ms {
        let local = cur + offset_ms;
        let day_start_local = local.div_euclid(day_ms) * day_ms;
        let next_utc = day_start_local + day_ms - offset_ms;
        let seg_end = end_ms.min(next_utc.max(cur + 1));
        out.push((day_start_local, seg_end - cur));
        cur = seg_end;
    }
    out
}

fn bucket_label(bucket: Bucket, local_day_ms: i64) -> (String, String) {
    let date = Utc
        .timestamp_millis_opt(local_day_ms)
        .single()
        .map(|d| d.date_naive())
        .unwrap_or_else(|| Utc.timestamp_millis_opt(0).unwrap().date_naive());
    match bucket {
        Bucket::Day => {
            let key = date.format("%Y-%m-%d").to_string();
            (key.clone(), key)
        }
        Bucket::Week => {
            let monday =
                date - chrono::Duration::days(date.weekday().num_days_from_monday() as i64);
            let key = monday.format("%Y-%m-%d").to_string();
            (format!("{} 周", monday.format("%Y-%m-%d")), key)
        }
        Bucket::Month => {
            let key = date.format("%Y-%m").to_string();
            (key.clone(), key)
        }
    }
}

fn new_trend(label: String, start_at: String) -> TrendPoint {
    TrendPoint {
        bucket: label,
        start_at,
        runs: 0,
        completed: 0,
        failed: 0,
        exec_sec: 0,
        wait_sec: 0,
        unknown_sec: 0,
    }
}

fn validate_origin(raw: Option<&str>) -> AppResult<&'static str> {
    match raw.unwrap_or("real") {
        "real" => Ok("real"),
        "selftest" => Ok("selftest"),
        "benchmark" => Ok("benchmark"),
        "mock" => Ok("mock"),
        "manual" => Ok("manual"),
        _ => Err(AppError::Validation(
            "origin 只支持 real/selftest/benchmark/mock/manual".into(),
        )),
    }
}

/// 执行一次工作统计查询。`conn` 应为只读连接（WAL 快照），函数内只执行 SELECT。
pub fn compute(
    conn: &Connection,
    q: &WorkTimeStatsQuery,
    now: DateTime<Utc>,
) -> AppResult<WorkTimeStats> {
    let from = DateTime::parse_from_rfc3339(&q.from)
        .map_err(|_| AppError::Validation("from 不是合法的 RFC3339 时间".into()))?
        .with_timezone(&Utc);
    let to = DateTime::parse_from_rfc3339(&q.to)
        .map_err(|_| AppError::Validation("to 不是合法的 RFC3339 时间".into()))?
        .with_timezone(&Utc);
    if to <= from {
        return Err(AppError::Validation("统计区间必须满足 from < to".into()));
    }
    if (to - from).num_days() > MAX_RANGE_DAYS {
        return Err(AppError::Validation(format!(
            "统计区间最长 {} 天",
            MAX_RANGE_DAYS
        )));
    }
    let origin = validate_origin(q.origin.as_deref())?;
    let bucket = Bucket::parse(q.bucket.as_deref().unwrap_or("day"))?;
    let offset_min = q.timezone_offset_minutes.unwrap_or(0).clamp(-840, 840);
    let max_runs = q
        .max_runs
        .unwrap_or(DEFAULT_MAX_RUNS)
        .clamp(1, HARD_MAX_RUNS);
    let session_limit = q
        .session_limit
        .unwrap_or(DEFAULT_SESSION_LIMIT)
        .clamp(1, MAX_SESSION_LIMIT);
    if let Some(sid) = &q.source_id {
        if sid.len() > 128 {
            return Err(AppError::Validation("source_id 过长".into()));
        }
    }

    let from_iso = from.to_rfc3339();
    let to_iso = to.to_rfc3339();
    let now_ms = now.timestamp_millis();
    let from_ms = from.timestamp_millis();

    // 1) 来源列表（供前端筛选；all sources，hidden 由前端处理）
    let mut available_sources: Vec<SourceOption> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, display_name, category, hidden FROM agent_sources ORDER BY hidden, display_name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SourceOption {
                id: r.get(0)?,
                display_name: r.get(1)?,
                category: r.get(2)?,
                hidden: r.get::<_, i64>(3)? != 0,
            })
        })?;
        for row in rows {
            available_sources.push(row?);
        }
    }
    let source_names: HashMap<String, String> = available_sources
        .iter()
        .map(|s| (s.id.clone(), s.display_name.clone()))
        .collect();

    // 2) 范围内轮次总数（真实总数，不受上限影响）
    let runs_in_range: i64 = conn.query_row(
        "SELECT COUNT(*) FROM agent_runs r
         WHERE r.origin = ?1
           AND (?2 IS NULL OR r.source_id = ?2)
           AND r.started_at < ?3
           AND COALESCE(NULLIF(r.last_event_at, ''), NULLIF(r.ended_at, ''), r.updated_at) >= ?4",
        params![origin, q.source_id, to_iso, from_iso],
        |r| r.get(0),
    )?;

    // 3) 轮次列表（时间范围 + 来源隔离 + 上限）
    let limit = max_runs as i64 + 1;
    let mut run_rows: Vec<RunRow> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT r.session_id, r.source_id, r.external_run_id, r.status,
                    r.started_at, r.ended_at, r.last_event_at, r.updated_at,
                    s.external_id, s.title, s.status, s.last_seen_at
             FROM agent_runs r
             JOIN agent_sessions s ON s.id = r.session_id
             WHERE r.origin = ?1
               AND (?2 IS NULL OR r.source_id = ?2)
               AND r.started_at < ?3
               AND COALESCE(NULLIF(r.last_event_at, ''), NULLIF(r.ended_at, ''), r.updated_at) >= ?4
             ORDER BY r.started_at DESC
             LIMIT ?5",
        )?;
        let rows = stmt.query_map(params![origin, q.source_id, to_iso, from_iso, limit], |r| {
            Ok(RunRow {
                session_id: r.get(0)?,
                source_id: r.get(1)?,
                external_run_id: r.get(2)?,
                status: r.get(3)?,
                started_at: r.get(4)?,
                ended_at: r.get(5)?,
                last_event_at: r.get(6)?,
                updated_at: r.get(7)?,
                session_external_id: r.get(8)?,
                session_title: r.get(9)?,
                session_status: r.get(10)?,
                session_last_seen_at: r.get(11)?,
            })
        })?;
        for row in rows {
            run_rows.push(row?);
        }
    }
    let runs_truncated = run_rows.len() > max_runs as usize;
    if runs_truncated {
        run_rows.truncate(max_runs as usize);
    }

    // 4) 事件载入：有 run_id 的按来源 + 外部 run ID 批量取；无 run_id 的按会话取后按时间窗归属
    let mut events: HashMap<(String, String), Vec<RawEvent>> = HashMap::new();
    let mut session_events: HashMap<(String, String), Vec<RawEvent>> = HashMap::new();
    let mut events_loaded: u32 = 0;
    let mut events_truncated = false;
    let mut fallback_time_events: u32 = 0;
    let mut unattributed_events: u32 = 0;
    let mut budget = MAX_EVENTS;

    // 每组的下界：max(窗口前 6h, 组内最早轮次 started_at)
    let mut ext_groups: HashMap<String, (Vec<String>, i64)> = HashMap::new();
    let mut session_groups: HashMap<String, (Vec<String>, i64)> = HashMap::new();
    for r in &run_rows {
        let started = parse_ms(&r.started_at).unwrap_or(from_ms);
        let lower = (from_ms - EVENT_LOOKBACK_MS).max(started);
        if let Some(ext) = &r.external_run_id {
            let entry = ext_groups
                .entry(r.source_id.clone())
                .or_insert_with(|| (Vec::new(), lower));
            entry.0.push(ext.clone());
            entry.1 = entry.1.min(lower);
        }
        // 会话内孤儿事件（run_external_id IS NULL）对**所有**轮次所在会话都要载入：
        // 只载入「存在无 run_id 轮次」的会话会漏掉精确轮次会话里的孤儿事件，
        // 它们既不参与统计也不计入「无法归属」，质量口径会静默少报。
        let entry = session_groups
            .entry(r.source_id.clone())
            .or_insert_with(|| (Vec::new(), lower));
        entry.0.push(r.session_external_id.clone());
        entry.1 = entry.1.min(lower);
    }

    for (source_id, (mut ids, lower_ms)) in ext_groups {
        ids.sort();
        ids.dedup();
        if budget == 0 {
            events_truncated = true;
            break;
        }
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT run_external_id, state, occurred_at, received_at, evidence_type, confidence, ingest_seq
             FROM agent_events
             WHERE source_id = ? AND origin = ? AND run_external_id IN ({})
               AND COALESCE(occurred_at, received_at) >= ? AND COALESCE(occurred_at, received_at) < ?
             ORDER BY ingest_seq ASC
             LIMIT ?",
            placeholders
        );
        let mut params_vec: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(source_id.clone()),
            rusqlite::types::Value::Text(origin.to_string()),
        ];
        for id in &ids {
            params_vec.push(rusqlite::types::Value::Text(id.clone()));
        }
        params_vec.push(rusqlite::types::Value::Text(
            Utc.timestamp_millis_opt(lower_ms).unwrap().to_rfc3339(),
        ));
        params_vec.push(rusqlite::types::Value::Text(to_iso.clone()));
        params_vec.push(rusqlite::types::Value::Integer(budget as i64 + 1));
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(params_vec))?;
        while let Some(row) = rows.next()? {
            if budget == 0 {
                events_truncated = true;
                break;
            }
            budget -= 1;
            events_loaded += 1;
            let ext: String = row.get(0)?;
            let raw = event_from_row(row, 1, &mut fallback_time_events)?;
            events
                .entry((source_id.clone(), ext))
                .or_default()
                .push(raw);
        }
    }

    for (source_id, (mut ids, lower_ms)) in session_groups {
        ids.sort();
        ids.dedup();
        if budget == 0 {
            events_truncated = true;
            break;
        }
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT session_external_id, state, occurred_at, received_at, evidence_type, confidence, ingest_seq
             FROM agent_events
             WHERE source_id = ? AND origin = ? AND run_external_id IS NULL
               AND session_external_id IN ({})
               AND COALESCE(occurred_at, received_at) >= ? AND COALESCE(occurred_at, received_at) < ?
             ORDER BY ingest_seq ASC
             LIMIT ?",
            placeholders
        );
        let mut params_vec: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(source_id.clone()),
            rusqlite::types::Value::Text(origin.to_string()),
        ];
        for id in &ids {
            params_vec.push(rusqlite::types::Value::Text(id.clone()));
        }
        params_vec.push(rusqlite::types::Value::Text(
            Utc.timestamp_millis_opt(lower_ms).unwrap().to_rfc3339(),
        ));
        params_vec.push(rusqlite::types::Value::Text(to_iso.clone()));
        params_vec.push(rusqlite::types::Value::Integer(budget as i64 + 1));
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(params_vec))?;
        while let Some(row) = rows.next()? {
            if budget == 0 {
                events_truncated = true;
                break;
            }
            budget -= 1;
            events_loaded += 1;
            let sid: String = row.get(0)?;
            let raw = event_from_row(row, 1, &mut fallback_time_events)?;
            session_events
                .entry((source_id.clone(), sid))
                .or_default()
                .push(raw);
        }
    }

    // 5) 无 run_id 轮次的会话内时间窗归属
    let mut session_run_index: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (idx, r) in run_rows.iter().enumerate() {
        session_run_index
            .entry((r.source_id.clone(), r.session_external_id.clone()))
            .or_default()
            .push(idx);
    }
    for list in session_run_index.values_mut() {
        list.sort_by_key(|idx| parse_ms(&run_rows[*idx].started_at).unwrap_or(i64::MIN));
    }
    let mut attributed: Vec<Vec<RawEvent>> = vec![Vec::new(); run_rows.len()];
    let mut window_attributed = vec![false; run_rows.len()];
    for ((source_id, session_external), evs) in &session_events {
        let Some(list) = session_run_index.get(&(source_id.clone(), session_external.clone()))
        else {
            unattributed_events += evs.len() as u32;
            continue;
        };
        let starts: Vec<i64> = list
            .iter()
            .map(|idx| parse_ms(&run_rows[*idx].started_at).unwrap_or(i64::MIN))
            .collect();
        for ev in evs {
            let Some(t) = ev.occurred_ms else {
                // 无时间的事件无法归属
                unattributed_events += 1;
                continue;
            };
            let pos = starts.partition_point(|s| *s <= t);
            if pos == 0 {
                unattributed_events += 1;
                continue;
            }
            let idx = list[pos - 1];
            // 时间窗最近的轮次已经带精确 run_id：这些无 run_id 事件无法证明属于它。
            // 计入「无法归属」，既不塞给精确轮次（会污染执行/等待），也不给它打「估算」标。
            if run_rows[idx].external_run_id.is_some() {
                unattributed_events += 1;
                continue;
            }
            attributed[idx].push(ev.clone());
            window_attributed[idx] = true;
        }
    }

    // 6) 逐轮计算
    let range = timeline::Range {
        from_ms,
        to_ms: to.timestamp_millis(),
    };
    let mut totals = StatsTotals::default();
    let mut quality = StatsQuality::default();
    quality.unattributed_events = unattributed_events;
    quality.window_attributed_runs = window_attributed.iter().filter(|v| **v).count() as u32;

    let mut by_source: BTreeMap<String, StatsAcc> = BTreeMap::new();
    let mut sessions: HashMap<String, SessionAcc> = HashMap::new();
    let mut trend: BTreeMap<String, TrendPoint> = BTreeMap::new();
    let mut trend_meta: BTreeMap<String, String> = BTreeMap::new();

    for (idx, r) in run_rows.iter().enumerate() {
        let ext_events = r
            .external_run_id
            .as_ref()
            .and_then(|ext| events.get(&(r.source_id.clone(), ext.clone())));
        let run_events: Vec<RawEvent> = match ext_events {
            Some(evs) => evs.clone(),
            None => attributed[idx].clone(),
        };
        let last_event_ms = parse_ms(&r.last_event_at)
            .or_else(|| parse_ms(&r.ended_at.clone().unwrap_or_default()))
            .or_else(|| parse_ms(&r.updated_at));
        let input = RunInput {
            status: r.status.clone(),
            started_ms: parse_ms(&r.started_at),
            ended_ms: r.ended_at.as_deref().and_then(parse_ms),
            last_event_ms,
            events: run_events,
        };
        let mut analyzed = analyze_run(&input, range, now_ms, timeline::MAX_PLAUSIBLE_GAP_MS);
        let detail_usable = !analyzed.flags.no_event_detail;
        analyzed.flags.window_attributed = window_attributed[idx] && detail_usable;
        if !detail_usable {
            // 没有可用事件明细的轮次：跨度可信，执行/等待一律未知
            analyzed.slices.clear();
        }

        // 汇总
        totals.runs += 1;
        if detail_usable {
            totals.runs_with_detail += 1;
        } else {
            totals.runs_without_detail += 1;
            quality.no_detail_runs += 1;
        }
        match analyzed.terminal {
            Terminal::Completed => totals.completed += 1,
            Terminal::Failed => totals.failed += 1,
            Terminal::Interrupted => totals.interrupted += 1,
            Terminal::Unresolved => totals.unresolved += 1,
            Terminal::UnknownTerminal => totals.unverified_terminal += 1,
        }
        totals.span_sec += secs(analyzed.span_ms);
        totals.open_tail_sec += secs(analyzed.open_tail_ms);
        let mut exec_ms = 0i64;
        let mut wait_ms = 0i64;
        let mut idle_ms = 0i64;
        let mut unknown_ms = 0i64;
        for s in &analyzed.slices {
            let d = s.end_ms - s.start_ms;
            match s.kind {
                SliceKind::Exec => {
                    exec_ms += d;
                    add_to_buckets(
                        &mut trend,
                        &mut trend_meta,
                        bucket,
                        offset_min,
                        s.start_ms,
                        s.end_ms,
                        d,
                        SliceKind::Exec,
                    );
                }
                SliceKind::Wait => {
                    wait_ms += d;
                    add_to_buckets(
                        &mut trend,
                        &mut trend_meta,
                        bucket,
                        offset_min,
                        s.start_ms,
                        s.end_ms,
                        d,
                        SliceKind::Wait,
                    );
                }
                SliceKind::Idle => idle_ms += d,
                SliceKind::Unknown => {
                    unknown_ms += d;
                    add_to_buckets(
                        &mut trend,
                        &mut trend_meta,
                        bucket,
                        offset_min,
                        s.start_ms,
                        s.end_ms,
                        d,
                        SliceKind::Unknown,
                    );
                }
            }
        }
        totals.exec_sec += secs(exec_ms);
        totals.wait_sec += secs(wait_ms);
        totals.idle_sec += secs(idle_ms);
        totals.unknown_sec += secs(unknown_ms);
        if analyzed.flags.estimated {
            totals.estimated_runs += 1;
        }
        if analyzed.flags.window_attributed {
            totals.window_attributed_runs += 1;
        }
        if analyzed.flags.missing_start {
            quality.missing_start_runs += 1;
        }
        if analyzed.flags.missing_end {
            quality.missing_end_runs += 1;
        }
        if analyzed.flags.stale_open {
            quality.stale_open_runs += 1;
        }
        quality.late_events += analyzed.flags.late_events;
        quality.unknown_timestamp_events += analyzed.flags.unknown_timestamp_events;
        quality.coalesced_events += analyzed.flags.coalesced_events;
        quality.unreliable_intervals += analyzed.flags.unreliable_intervals;
        quality.gap_unknown_sec += secs(analyzed.flags.gap_unknown_ms);

        // 来源维度
        let acc = by_source.entry(r.source_id.clone()).or_default();
        acc.runs += 1;
        if !detail_usable {
            acc.runs_without_detail += 1;
        }
        match analyzed.terminal {
            Terminal::Completed => acc.completed += 1,
            Terminal::Failed => acc.failed += 1,
            Terminal::Unresolved | Terminal::UnknownTerminal | Terminal::Interrupted => {
                acc.unresolved += 1
            }
        }
        acc.span_ms += analyzed.span_ms;
        acc.exec_ms += exec_ms;
        acc.wait_ms += wait_ms;
        acc.unknown_ms += unknown_ms;

        // 会话维度
        let sacc = sessions
            .entry(r.session_id.clone())
            .or_insert_with(|| SessionAcc {
                source_id: r.source_id.clone(),
                external_id: r.session_external_id.clone(),
                title: r.session_title.clone(),
                status: r.session_status.clone(),
                last_seen_at: r.session_last_seen_at.clone(),
                ..Default::default()
            });
        sacc.runs += 1;
        if !detail_usable {
            sacc.runs_without_detail += 1;
        }
        match analyzed.terminal {
            Terminal::Completed => sacc.completed += 1,
            Terminal::Failed => sacc.failed += 1,
            _ => sacc.unresolved += 1,
        }
        sacc.span_ms += analyzed.span_ms;
        sacc.exec_ms += exec_ms;
        sacc.wait_ms += wait_ms;
        sacc.open_tail_ms += analyzed.open_tail_ms;
        sacc.last_seen_at = sacc
            .last_seen_at
            .clone()
            .max(r.session_last_seen_at.clone());

        // 趋势：轮次计数按开始时间归入桶
        if let Some(st) = input.started_ms {
            if st >= from_ms && st < range.to_ms {
                let (label, start_at) = bucket_for_ms(bucket, offset_min, st);
                let point = trend
                    .entry(start_at.clone())
                    .or_insert_with(|| new_trend(label.clone(), start_at.clone()));
                trend_meta.insert(start_at.clone(), label);
                point.runs += 1;
                match analyzed.terminal {
                    Terminal::Completed => point.completed += 1,
                    Terminal::Failed => point.failed += 1,
                    _ => {}
                }
            }
        }
    }

    fill_empty_buckets(
        &mut trend,
        &mut trend_meta,
        bucket,
        offset_min,
        from_ms,
        range.to_ms,
    );

    // 7) 失败率（仅可靠终态）
    let denom = totals.completed + totals.failed;
    totals.failure_rate = if denom > 0 {
        Some(totals.failed as f64 / denom as f64)
    } else {
        None
    };

    let mut by_source_vec: Vec<SourceStats> = by_source
        .into_iter()
        .map(|(source_id, acc)| {
            let denom = acc.completed + acc.failed;
            SourceStats {
                display_name: source_names
                    .get(&source_id)
                    .cloned()
                    .unwrap_or_else(|| source_id.clone()),
                source_id,
                runs: acc.runs,
                runs_without_detail: acc.runs_without_detail,
                completed: acc.completed,
                failed: acc.failed,
                unresolved: acc.unresolved,
                failure_rate: if denom > 0 {
                    Some(acc.failed as f64 / denom as f64)
                } else {
                    None
                },
                span_sec: secs(acc.span_ms),
                exec_sec: secs(acc.exec_ms),
                wait_sec: secs(acc.wait_ms),
                unknown_sec: secs(acc.unknown_ms),
            }
        })
        .collect();
    by_source_vec.sort_by(|a, b| b.exec_sec.cmp(&a.exec_sec).then(b.runs.cmp(&a.runs)));

    let sessions_total = sessions.len() as u32;
    let mut session_vec: Vec<SessionStats> = sessions
        .into_iter()
        .map(|(session_id, acc)| SessionStats {
            source_name: source_names
                .get(&acc.source_id)
                .cloned()
                .unwrap_or_else(|| acc.source_id.clone()),
            session_id,
            source_id: acc.source_id,
            external_id: acc.external_id,
            title: acc.title,
            status: acc.status,
            last_seen_at: acc.last_seen_at,
            runs: acc.runs,
            runs_without_detail: acc.runs_without_detail,
            completed: acc.completed,
            failed: acc.failed,
            unresolved: acc.unresolved,
            span_sec: secs(acc.span_ms),
            exec_sec: secs(acc.exec_ms),
            wait_sec: secs(acc.wait_ms),
            open_tail_sec: secs(acc.open_tail_ms),
        })
        .collect();
    session_vec.sort_by(|a, b| {
        b.exec_sec
            .cmp(&a.exec_sec)
            .then(b.span_sec.cmp(&a.span_sec))
            .then(a.external_id.cmp(&b.external_id))
    });
    let sessions_shown = (session_vec.len() as u32).min(session_limit);
    session_vec.truncate(session_limit as usize);

    let mut trend_vec: Vec<TrendPoint> = trend.into_values().collect();
    trend_vec.sort_by(|a, b| a.start_at.cmp(&b.start_at));

    // 8) 警示（供 UI 明确「未知 / 估算」）
    let mut warnings: Vec<String> = Vec::new();
    if runs_truncated {
        warnings.push(format!(
            "范围内共 {} 个轮次，本次仅分析最近 {} 个（可缩小时间范围）",
            runs_in_range, max_runs
        ));
    }
    if events_truncated {
        warnings.push(format!(
            "事件量超过上限 {}，部分轮次的时长可能不完整",
            MAX_EVENTS
        ));
    }
    if totals.window_attributed_runs > 0 {
        warnings.push(format!(
            "{} 个轮次没有 run_id：事件按会话内时间窗归属（估算，非精确归属）",
            totals.window_attributed_runs
        ));
    }
    if totals.runs_without_detail > 0 {
        warnings.push(format!(
            "{} 个轮次没有事件明细，执行/等待时长显示为未知",
            totals.runs_without_detail
        ));
    }
    if totals.unverified_terminal > 0 {
        warnings.push(format!(
            "{} 个轮次声称结束但没有可靠终态事件，不计入失败率",
            totals.unverified_terminal
        ));
    }
    if quality.stale_open_runs > 0 {
        warnings.push(format!(
            "{} 个轮次长时间无事件更新（疑似中断），末段未计入执行",
            quality.stale_open_runs
        ));
    }
    if quality.gap_unknown_sec > 0 {
        warnings.push(format!(
            "存在 {} 秒超过 4 小时的空档，无法确认执行，已归为未知",
            quality.gap_unknown_sec
        ));
    }
    if quality.unattributed_events > 0 {
        warnings.push(format!(
            "{} 条会话事件无法归属到任何轮次（已排除）",
            quality.unattributed_events
        ));
    }
    if fallback_time_events > 0 {
        warnings.push(format!(
            "{} 条事件缺少 occurred_at（用受理时间兜底），其区间不计入执行/等待",
            fallback_time_events
        ));
    }

    Ok(WorkTimeStats {
        generated_at: now.to_rfc3339(),
        range: StatsRange {
            from: from_iso,
            to: to_iso,
            origin: origin.to_string(),
            source_id: q.source_id.clone(),
            bucket: match bucket {
                Bucket::Day => "day",
                Bucket::Week => "week",
                Bucket::Month => "month",
            }
            .to_string(),
            timezone_offset_minutes: offset_min,
        },
        coverage: StatsCoverage {
            runs_in_range: runs_in_range as u32,
            runs_analyzed: totals.runs,
            run_limit: max_runs,
            runs_truncated,
            events_loaded,
            event_limit: MAX_EVENTS as u32,
            events_truncated,
            sessions_total,
            sessions_shown,
        },
        totals,
        by_source: by_source_vec,
        sessions: session_vec,
        trend: trend_vec,
        quality,
        available_sources,
        warnings,
    })
}

fn event_from_row(
    row: &rusqlite::Row<'_>,
    offset: usize,
    fallback_time_events: &mut u32,
) -> AppResult<RawEvent> {
    let state: String = row.get(offset)?;
    let occurred: Option<String> = row.get(offset + 1)?;
    let received: String = row.get(offset + 2)?;
    let mut evidence: String = row.get(offset + 3)?;
    let confidence: f64 = row.get(offset + 4)?;
    let ingest_seq: i64 = row.get(offset + 5)?;
    let occurred_ms = occurred.as_deref().and_then(parse_ms);
    let occurred_ms = match occurred_ms {
        Some(ms) => Some(ms),
        None => {
            let fb = parse_ms(&received);
            if fb.is_some() {
                *fallback_time_events += 1;
                evidence = RECEIVED_FALLBACK.to_string();
            }
            fb
        }
    };
    Ok(RawEvent {
        state,
        occurred_ms,
        evidence_type: evidence,
        confidence,
        ingest_seq,
    })
}

#[derive(Debug, Default)]
struct StatsAcc {
    runs: u32,
    runs_without_detail: u32,
    completed: u32,
    failed: u32,
    unresolved: u32,
    span_ms: i64,
    exec_ms: i64,
    wait_ms: i64,
    unknown_ms: i64,
}

#[derive(Debug, Default)]
struct SessionAcc {
    source_id: String,
    external_id: String,
    title: String,
    status: String,
    last_seen_at: String,
    runs: u32,
    runs_without_detail: u32,
    completed: u32,
    failed: u32,
    unresolved: u32,
    span_ms: i64,
    exec_ms: i64,
    wait_ms: i64,
    open_tail_ms: i64,
}

fn bucket_for_ms(bucket: Bucket, offset_min: i32, ms: i64) -> (String, String) {
    let offset_ms = offset_min as i64 * 60_000;
    let day_ms = 86_400_000i64;
    let local_day = (ms + offset_ms).div_euclid(day_ms) * day_ms;
    bucket_label(bucket, local_day)
}

#[allow(clippy::too_many_arguments)]
fn add_to_buckets(
    trend: &mut BTreeMap<String, TrendPoint>,
    meta: &mut BTreeMap<String, String>,
    bucket: Bucket,
    offset_min: i32,
    start_ms: i64,
    end_ms: i64,
    total_ms: i64,
    kind: SliceKind,
) {
    let parts = split_by_local_day(start_ms, end_ms, offset_min);
    let parts = if parts.is_empty() {
        vec![(start_ms + offset_min as i64 * 60_000, total_ms)]
    } else {
        parts
    };
    for (local_day, dur) in parts {
        let (label, start_at) = bucket_label(bucket, local_day);
        let point = trend
            .entry(start_at.clone())
            .or_insert_with(|| new_trend(label.clone(), start_at.clone()));
        meta.insert(start_at.clone(), label);
        match kind {
            SliceKind::Exec => point.exec_sec += secs(dur),
            SliceKind::Wait => point.wait_sec += secs(dur),
            SliceKind::Unknown => point.unknown_sec += secs(dur),
            SliceKind::Idle => {}
        }
    }
}

/// 补空桶，使趋势图连续（上限 400 个桶，超出则不补）。
fn fill_empty_buckets(
    trend: &mut BTreeMap<String, TrendPoint>,
    meta: &mut BTreeMap<String, String>,
    bucket: Bucket,
    offset_min: i32,
    from_ms: i64,
    to_ms: i64,
) {
    let offset_ms = offset_min as i64 * 60_000;
    let day_ms = 86_400_000i64;
    let start_local = (from_ms + offset_ms).div_euclid(day_ms) * day_ms;
    let end_local = (to_ms - 1 + offset_ms).div_euclid(day_ms) * day_ms;
    let mut keys: BTreeSet<String> = BTreeSet::new();
    let mut cur = start_local;
    while cur <= end_local && keys.len() < 400 {
        let (label, start_at) = bucket_label(bucket, cur);
        keys.insert(start_at.clone());
        meta.entry(start_at).or_insert(label);
        cur += match bucket {
            Bucket::Day => day_ms,
            Bucket::Week => 7 * day_ms,
            Bucket::Month => {
                // 跳到下个月：按本地日期计算
                let date = Utc
                    .timestamp_millis_opt(cur)
                    .single()
                    .map(|d| d.date_naive())
                    .unwrap_or_default();
                let (year, month) = if date.month() == 12 {
                    (date.year() + 1, 1)
                } else {
                    (date.year(), date.month() + 1)
                };
                let next = chrono::NaiveDate::from_ymd_opt(year, month, 1).unwrap_or(date);
                let next_local = next
                    .and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_utc()
                    .timestamp_millis();
                (next_local - cur).max(day_ms)
            }
        };
    }
    // 只补已收集的桶（循环内有 400 桶上限）；超出上限时不再继续按月推进。
    for key in keys {
        if !trend.contains_key(&key) {
            let label = meta.get(&key).cloned().unwrap_or_else(|| key.clone());
            trend.insert(key.clone(), new_trend(label, key));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{ingest_core, AgentEvent, Transport};
    use crate::db::Db;

    fn event(source: &str, session: &str, run: Option<&str>, state: &str, at: &str) -> AgentEvent {
        AgentEvent {
            source_id: source.into(),
            session_id: session.into(),
            run_id: run.map(|s| s.to_string()),
            state: state.into(),
            occurred_at: Some(at.into()),
            ..Default::default()
        }
    }

    fn range_query(from: &str, to: &str) -> WorkTimeStatsQuery {
        WorkTimeStatsQuery {
            from: from.into(),
            to: to.into(),
            origin: None,
            source_id: None,
            bucket: Some("day".into()),
            timezone_offset_minutes: Some(0),
            session_limit: Some(20),
            max_runs: Some(5000),
        }
    }

    #[test]
    fn real_runs_are_isolated_from_mock() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO agent_sources (id, display_name, created_at, updated_at)
                 VALUES ('codex','Codex','2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00')",
                [],
            )?;
            let now = "2026-01-01T00:00:00+00:00";
            // 真实轮次
            ingest_core(
                conn,
                &event("codex", "s1", Some("r1"), "running", now),
                now,
                Transport::Hook,
            )?;
            ingest_core(
                conn,
                &event(
                    "codex",
                    "s1",
                    Some("r1"),
                    "completed",
                    "2026-01-01T00:10:00+00:00",
                ),
                "2026-01-01T00:10:00+00:00",
                Transport::Hook,
            )?;
            // 模拟轮次（mock 来源整体隔离）
            ingest_core(
                conn,
                &event("mock", "m1", Some("mr1"), "running", now),
                now,
                Transport::Mock,
            )?;
            ingest_core(
                conn,
                &event(
                    "mock",
                    "m1",
                    Some("mr1"),
                    "failed",
                    "2026-01-01T00:10:00+00:00",
                ),
                "2026-01-01T00:10:00+00:00",
                Transport::Mock,
            )?;
            let stats = compute(
                conn,
                &range_query("2026-01-01T00:00:00+00:00", "2026-01-02T00:00:00+00:00"),
                DateTime::parse_from_rfc3339("2026-01-02T00:00:00+00:00")
                    .unwrap()
                    .with_timezone(&Utc),
            )?;
            assert_eq!(stats.totals.runs, 1, "默认只统计真实来源");
            assert_eq!(stats.totals.completed, 1);
            assert_eq!(stats.totals.exec_sec, 600);
            assert_eq!(stats.totals.failure_rate, Some(0.0));

            let mock = compute(
                conn,
                &WorkTimeStatsQuery {
                    origin: Some("mock".into()),
                    ..range_query("2026-01-01T00:00:00+00:00", "2026-01-02T00:00:00+00:00")
                },
                DateTime::parse_from_rfc3339("2026-01-02T00:00:00+00:00")
                    .unwrap()
                    .with_timezone(&Utc),
            )?;
            assert_eq!(mock.totals.runs, 1);
            assert_eq!(mock.totals.failed, 1);
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn missing_run_id_is_window_attributed() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO agent_sources (id, display_name, created_at, updated_at)
                 VALUES ('codex','Codex','2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00')",
                [],
            )?;
            let a = "2026-01-01T00:00:00+00:00";
            ingest_core(
                conn,
                &event("codex", "s1", None, "running", a),
                a,
                Transport::Hook,
            )?;
            ingest_core(
                conn,
                &event("codex", "s1", None, "waiting", "2026-01-01T00:05:00+00:00"),
                "2026-01-01T00:05:00+00:00",
                Transport::Hook,
            )?;
            ingest_core(
                conn,
                &event("codex", "s1", None, "running", "2026-01-01T00:15:00+00:00"),
                "2026-01-01T00:15:00+00:00",
                Transport::Hook,
            )?;
            ingest_core(
                conn,
                &event(
                    "codex",
                    "s1",
                    None,
                    "completed",
                    "2026-01-01T00:30:00+00:00",
                ),
                "2026-01-01T00:30:00+00:00",
                Transport::Hook,
            )?;
            let stats = compute(
                conn,
                &range_query("2026-01-01T00:00:00+00:00", "2026-01-02T00:00:00+00:00"),
                DateTime::parse_from_rfc3339("2026-01-02T00:00:00+00:00")
                    .unwrap()
                    .with_timezone(&Utc),
            )?;
            assert_eq!(stats.totals.runs, 1);
            assert_eq!(stats.totals.exec_sec, 20 * 60, "5 + 15 分钟执行");
            assert_eq!(stats.totals.wait_sec, 10 * 60);
            assert_eq!(stats.totals.window_attributed_runs, 1);
            assert!(stats.warnings.iter().any(|w| w.contains("run_id")));
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn range_clips_overnight_run() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO agent_sources (id, display_name, created_at, updated_at)
                 VALUES ('codex','Codex','2025-12-31T00:00:00+00:00','2025-12-31T00:00:00+00:00')",
                [],
            )?;
            ingest_core(
                conn,
                &event(
                    "codex",
                    "s1",
                    Some("r1"),
                    "running",
                    "2025-12-31T23:40:00+00:00",
                ),
                "2025-12-31T23:40:00+00:00",
                Transport::Hook,
            )?;
            ingest_core(
                conn,
                &event(
                    "codex",
                    "s1",
                    Some("r1"),
                    "completed",
                    "2026-01-01T00:10:00+00:00",
                ),
                "2026-01-01T00:10:00+00:00",
                Transport::Hook,
            )?;
            let stats = compute(
                conn,
                &range_query("2026-01-01T00:00:00+00:00", "2026-01-02T00:00:00+00:00"),
                DateTime::parse_from_rfc3339("2026-01-02T00:00:00+00:00")
                    .unwrap()
                    .with_timezone(&Utc),
            )?;
            assert_eq!(stats.totals.exec_sec, 10 * 60, "只计 00:00 之后的部分");
            assert_eq!(stats.totals.span_sec, 10 * 60);
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn failure_rate_is_none_without_reliable_terminal() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO agent_sources (id, display_name, created_at, updated_at)
                 VALUES ('codex','Codex','2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00')",
                [],
            )?;
            let t = "2026-01-01T00:00:00+00:00";
            ingest_core(conn, &event("codex", "s1", Some("r1"), "running", t), t, Transport::Hook)?;
            // 只有轮次状态字段声明结束，没有任何可靠 completed/failed 事件（事件丢失/旧数据）
            conn.execute(
                "UPDATE agent_runs SET status = 'completed', ended_at = '2026-01-01T00:10:00+00:00'",
                [],
            )?;
            let stats = compute(
                conn,
                &range_query("2026-01-01T00:00:00+00:00", "2026-01-02T00:00:00+00:00"),
                DateTime::parse_from_rfc3339("2026-01-02T00:00:00+00:00").unwrap().with_timezone(&Utc),
            )?;
            assert_eq!(stats.totals.unverified_terminal, 1);
            assert_eq!(stats.totals.completed, 0);
            assert_eq!(stats.totals.failed, 0);
            assert_eq!(
                stats.totals.failure_rate, None,
                "没有可靠终态时必须返回未知，不能退化成 0%"
            );
            assert_eq!(stats.totals.span_sec, 10 * 60, "跨度仍可由轮次起止给出");
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn null_run_id_events_do_not_pollute_exact_runs() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO agent_sources (id, display_name, created_at, updated_at)
                 VALUES ('codex','Codex','2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00')",
                [],
            )?;
            // s1：带 run_id 的精确轮次 r1（00:00 → 00:10）
            ingest_core(
                conn,
                &event(
                    "codex",
                    "s1",
                    Some("r1"),
                    "running",
                    "2026-01-01T00:00:00+00:00",
                ),
                "2026-01-01T00:00:00+00:00",
                Transport::Hook,
            )?;
            ingest_core(
                conn,
                &event(
                    "codex",
                    "s1",
                    Some("r1"),
                    "completed",
                    "2026-01-01T00:10:00+00:00",
                ),
                "2026-01-01T00:10:00+00:00",
                Transport::Hook,
            )?;
            // s1 里一条迟到且无 run_id 的事件（落在 r1 的时间窗内），只入事件流水
            ingest_core(
                conn,
                &event("codex", "s1", None, "waiting", "2026-01-01T00:05:00+00:00"),
                "2026-01-01T00:11:00+00:00",
                Transport::Hook,
            )?;
            // s2：完全无 run_id 的轮次（提供会话事件的载入下界，并应被标记为时间窗归属）
            ingest_core(
                conn,
                &event("codex", "s2", None, "running", "2026-01-01T00:00:00+00:00"),
                "2026-01-01T00:00:01+00:00",
                Transport::Hook,
            )?;
            ingest_core(
                conn,
                &event(
                    "codex",
                    "s2",
                    None,
                    "completed",
                    "2026-01-01T00:30:00+00:00",
                ),
                "2026-01-01T00:30:01+00:00",
                Transport::Hook,
            )?;

            let stats = compute(
                conn,
                &range_query("2026-01-01T00:00:00+00:00", "2026-01-02T00:00:00+00:00"),
                DateTime::parse_from_rfc3339("2026-01-02T00:00:00+00:00")
                    .unwrap()
                    .with_timezone(&Utc),
            )?;
            assert_eq!(stats.totals.runs, 2);
            assert_eq!(
                stats.totals.window_attributed_runs, 1,
                "只有真正没有 run_id 的轮次算估算，精确轮次不得被标记"
            );
            assert_eq!(
                stats.quality.unattributed_events, 1,
                "落在精确轮次时间窗内的无 run_id 事件计入无法归属，不塞给精确轮次"
            );
            assert_eq!(stats.totals.exec_sec, 10 * 60 + 30 * 60);
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn local_day_boundaries_follow_timezone_offset() {
        const HOUR: i64 = 3_600_000;
        let t = DateTime::parse_from_rfc3339("2026-01-01T20:00:00+00:00")
            .unwrap()
            .timestamp_millis();
        // UTC+8：20:00Z = 本地 01-02 04:00
        let (label, _) = bucket_for_ms(Bucket::Day, 480, t);
        assert_eq!(label, "2026-01-02");
        let (utc_label, _) = bucket_for_ms(Bucket::Day, 0, t);
        assert_eq!(utc_label, "2026-01-01", "偏移为 0 时按 UTC 日切分");
        // 单段未跨本地零点：不切分
        let parts = split_by_local_day(t, t + 6 * HOUR, 480);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].1, 6 * HOUR);
        // 跨本地零点（本地 01-02 23:00 → 01-03 01:00）切成两段，各 1 小时
        let start = DateTime::parse_from_rfc3339("2026-01-02T23:00:00+08:00")
            .unwrap()
            .timestamp_millis();
        let segs = split_by_local_day(start, start + 2 * HOUR, 480);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].1, HOUR);
        assert_eq!(segs[1].1, HOUR);
    }
}
