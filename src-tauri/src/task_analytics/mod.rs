//! 任务统计与效率分析（`tasks.stats-trends`）。
//!
//! 设计边界（验收时必须如实披露，不扩大口径）：
//! - 只统计**可精确计算**的事实：真实发生的完成动作（完成事件）、本期到期发生次数。
//! - 不产出「效率评分」「AI 评分」等没有数据支撑的指标；完成数量不等于效率。
//! - 完成率 / 逾期率的分母固定为**本期到期任务数**，口径原文随响应返回给前端展示。
//! - 完成事实的唯一来源是 `task_completion_events`：普通任务完成时写入；
//!   重复任务完成后任务保持 `pending` 并推进到下一期，只有事件表能还原
//!   「哪一期在何时被完成」。重复任务的历史期次在升级前不可还原，**不做伪造回填**。
//! - 本地时区：日历边界在 Rust 用 `Local` 计算成 UTC 瞬间后下推 SQL，
//!   不依赖 SQLite `date()`（它是 UTC），跨日 / 跨月 / 跨年不会错位。
//! - 查询范围有界：只读取趋势窗口内的事件与本期/趋势窗口内到期的任务，
//!   不做全表扫描、不轮询；前端只在统计子视图打开时按需调用。

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Datelike, Duration, Local, MappedLocalTime, NaiveDate, TimeZone, Utc};
use rusqlite::Connection;
use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 统计范围（日 / 周 / 月）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeKind {
    Day,
    Week,
    Month,
}

impl RangeKind {
    pub fn parse(raw: Option<&str>) -> AppResult<Self> {
        match raw.unwrap_or("day") {
            "day" | "today" => Ok(Self::Day),
            "week" => Ok(Self::Week),
            "month" => Ok(Self::Month),
            other => Err(AppError::Validation(format!("未知统计范围: {other}"))),
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Day => "今日",
            Self::Week => "本周",
            Self::Month => "本月",
        }
    }
}

/// 本期汇总。
#[derive(Debug, Clone, Default, Serialize)]
pub struct AnalyticsSummary {
    /// 本期实际完成数量（完成事件数，含重复任务的每次完成）
    pub completed: i64,
    /// 其中重复任务的完成次数
    pub recurring_completed: i64,
    /// 本期到期任务数（分母；含已完成与未完成）
    pub due: i64,
    /// 本期到期任务中已完成的数量
    pub due_completed: i64,
    /// 本期到期任务中逾期的数量
    pub due_overdue: i64,
    /// due_completed / due；分母为 0 时为 null（前端显示「—」，不显示 0%）
    pub completion_rate: Option<f64>,
    /// due_overdue / due；分母为 0 时为 null
    pub overdue_rate: Option<f64>,
}

/// 趋势分桶。`completed` 与 `overdue` 共用计数刻度，前端可画双序列。
#[derive(Debug, Clone, Serialize)]
pub struct TrendPoint {
    /// 分桶起始本地日期（稳定 key）
    pub key: String,
    pub label: String,
    /// 分桶 [start, end) 的 UTC 瞬间（ISO8601）
    pub start: String,
    pub end: String,
    pub completed: i64,
    pub due: i64,
    pub due_completed: i64,
    pub due_overdue: i64,
    pub completion_rate: Option<f64>,
    pub overdue_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CategoryStat {
    pub category: String,
    pub completed: i64,
    /// 占本期完成数的比例（0..1）
    pub share: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PriorityStat {
    pub priority: u8,
    pub completed: i64,
    pub share: f64,
}

/// 指标口径原文：由后端返回、前端原样展示，避免前后端各写一份造成漂移。
#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsDefinitions {
    pub completed: &'static str,
    pub completion_rate: &'static str,
    pub overdue_rate: &'static str,
    pub trend: &'static str,
    pub distribution: &'static str,
    pub history: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskAnalytics {
    pub range: &'static str,
    pub range_label: &'static str,
    /// 本期起始本地日期（含）
    pub range_start: String,
    /// 本期结束本地日期（不含，前端展示时可减一天）
    pub range_end: String,
    pub generated_at: String,
    pub summary: AnalyticsSummary,
    pub trend: Vec<TrendPoint>,
    pub by_category: Vec<CategoryStat>,
    pub by_priority: Vec<PriorityStat>,
    /// 分母完整性：`false` 表示本期窗口内存在无法还原的重复任务到期期次
    /// （调度器自动推进、停机补偿跳期、用户主动改期等没有独立记录），
    /// 此时完成率 / 逾期率的分母偏小、可能偏高。
    /// 非重复任务与可还原的完成事件仍按实际统计。
    pub history_complete: bool,
    pub definitions: AnalyticsDefinitions,
}

#[derive(Debug, Clone)]
struct EventRow {
    task_id: String,
    completed_at: String,
    due_at: Option<String>,
    category: String,
    priority: i64,
    kind: String,
}

/// 重复任务规则快照（统计只读；不参与推进，也不修改任何规则）。
#[derive(Debug, Clone)]
struct RecurringTaskRow {
    task_id: String,
    due_at: Option<String>,
    created_at: String,
    freq: String,
    interval: i64,
    by_weekday: Vec<u32>,
    by_monthday: Option<u32>,
    by_setpos: Option<i32>,
    until: Option<String>,
    anchor: String,
}

#[derive(Debug, Clone)]
struct DueTaskRow {
    id: String,
    due_at: String,
    status: String,
    completed_at: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    start: NaiveDate,
    end: NaiveDate,
}

#[derive(Debug, Clone, Default)]
struct BucketStat {
    completed: i64,
    recurring_completed: i64,
    due: i64,
    due_completed: i64,
    due_overdue: i64,
}

fn rate(n: i64, d: i64) -> Option<f64> {
    if d <= 0 {
        None
    } else {
        Some(n as f64 / d as f64)
    }
}

fn parse_utc(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|v| v.with_timezone(&Utc))
}

/// 本地午夜 → UTC 瞬间。极少数 DST 跳变日期退化为 UTC 午夜，保证不 panic。
fn local_midnight(date: NaiveDate) -> DateTime<Utc> {
    let naive = date.and_hms_opt(0, 0, 0).expect("00:00:00 必然合法");
    match Local.from_local_datetime(&naive) {
        MappedLocalTime::Single(dt) => dt.with_timezone(&Utc),
        MappedLocalTime::Ambiguous(earliest, _) => earliest.with_timezone(&Utc),
        MappedLocalTime::None => naive.and_utc(),
    }
}

fn shift_days(date: NaiveDate, days: i64) -> NaiveDate {
    date.checked_add_signed(Duration::days(days))
        .unwrap_or(date)
}

fn month_start(year: i32, month0: i32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month0 as u32 + 1, 1).unwrap_or(NaiveDate::MIN)
}

/// 当前月起点向过去偏移 `delta` 个月（delta 为负）。
fn shift_months(base: NaiveDate, delta: i32) -> NaiveDate {
    let total = base.year() * 12 + base.month0() as i32 + delta;
    let year = total.div_euclid(12);
    let month0 = total.rem_euclid(12);
    month_start(year, month0)
}

/// 本期窗口 [start, end)（本地日历）。
fn range_window(kind: RangeKind, today: NaiveDate) -> (NaiveDate, NaiveDate) {
    match kind {
        RangeKind::Day => (today, shift_days(today, 1)),
        RangeKind::Week => {
            let start = shift_days(today, -(today.weekday().num_days_from_monday() as i64));
            (start, shift_days(start, 7))
        }
        RangeKind::Month => {
            let start = month_start(today.year(), today.month0() as i32);
            (start, shift_months(start, 1))
        }
    }
}

/// 趋势分桶：日视图近 14 天、周视图近 12 周、月视图近 12 月；最后一桶即本期。
fn trend_buckets(kind: RangeKind, today: NaiveDate) -> Vec<Bucket> {
    match kind {
        RangeKind::Day => (0..14)
            .map(|i| {
                let start = shift_days(today, -(13 - i));
                Bucket {
                    start,
                    end: shift_days(start, 1),
                }
            })
            .collect(),
        RangeKind::Week => {
            let (current, _) = range_window(kind, today);
            (0..12)
                .map(|i| {
                    let start = shift_days(current, -(7 * (11 - i)));
                    Bucket {
                        start,
                        end: shift_days(start, 7),
                    }
                })
                .collect()
        }
        RangeKind::Month => {
            let (current, _) = range_window(kind, today);
            (0..12)
                .map(|i| {
                    let start = shift_months(current, i - 11);
                    Bucket {
                        start,
                        end: shift_months(start, 1),
                    }
                })
                .collect()
        }
    }
}

fn bucket_label(kind: RangeKind, bucket: &Bucket, this_year: i32) -> String {
    match kind {
        RangeKind::Day | RangeKind::Week => bucket.start.format("%m-%d").to_string(),
        RangeKind::Month => {
            if bucket.start.year() == this_year {
                format!("{}月", bucket.start.month())
            } else {
                format!("{}年{}月", bucket.start.year(), bucket.start.month())
            }
        }
    }
}

fn bucket_index(bounds: &[(DateTime<Utc>, DateTime<Utc>)], at: DateTime<Utc>) -> Option<usize> {
    // 桶数量很小（14 / 12），线性查找即可，避免引入二分边界的额外复杂度。
    bounds
        .iter()
        .position(|(start, end)| at >= *start && at < *end)
}

fn normalize_category(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "未分类".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 读取趋势窗口内的事件、到期任务与重复规则（有界查询，不做全表扫描）。
///
/// 四条查询在同一个只读事务内执行，保证「任务行 / 完成事件 / 事件存在性 / 规则」
/// 来自同一快照；否则并发完成恰好落在两条语句之间时，会出现完成数已加、到期数
/// 未加（或相反）的瞬时偏差。
fn load_rows(
    conn: &Connection,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> AppResult<(
    Vec<EventRow>,
    Vec<DueTaskRow>,
    HashSet<String>,
    Vec<RecurringTaskRow>,
)> {
    let start_iso = start.to_rfc3339();
    let end_iso = end.to_rfc3339();
    // 锚点存的是本地日期，窗口结束是「本地午夜对应的 UTC 瞬间」；在正时区直接对
    // UTC 瞬间取 date() 会退回前一天。这里先转成本地日期字符串再比较。
    let end_local_date = end
        .with_timezone(&Local)
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let tx = conn.unchecked_transaction()?;

    let events = {
        let mut stmt = tx.prepare(
            "SELECT task_id, completed_at, due_at, category, priority, kind
             FROM task_completion_events
             WHERE (completed_at >= ?1 AND completed_at < ?2)
                OR (due_at IS NOT NULL AND due_at >= ?1 AND due_at < ?2)",
        )?;
        let rows = stmt.query_map(rusqlite::params![start_iso, end_iso], |row| {
            Ok(EventRow {
                task_id: row.get(0)?,
                completed_at: row.get(1)?,
                due_at: row.get(2)?,
                category: row.get(3)?,
                priority: row.get(4)?,
                kind: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let tasks = {
        let mut stmt = tx.prepare(
            "SELECT id, due_at, status, completed_at
             FROM tasks
             WHERE due_at IS NOT NULL AND due_at >= ?1 AND due_at < ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![start_iso, end_iso], |row| {
            Ok(DueTaskRow {
                id: row.get(0)?,
                due_at: row.get(1)?,
                status: row.get(2)?,
                completed_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    // 已完成任务若存在完成事件，到期发生以事件快照为准：任务行的 due_at 可能在
    // 完成之后被再次编辑，直接用任务行会把一次完成算成两个到期（原 due + 新 due）。
    // 这里只取 task_id；事件自身 due_at 落在窗口内的已由上面的查询读取，
    // 落在窗口外的说明该期次不属于本期。
    let completed_with_events = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT e.task_id
             FROM task_completion_events e
             JOIN tasks t ON t.id = e.task_id
             WHERE t.status = 'completed'
               AND t.due_at IS NOT NULL
               AND t.due_at >= ?1 AND t.due_at < ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![start_iso, end_iso], |row| {
            row.get::<_, String>(0)
        })?;
        rows.collect::<Result<HashSet<_>, _>>()?
    };

    // 只读取可能在本窗口产生到期期次的重复任务：规则锚点早于窗口结束，且规则
    // 未在窗口开始前结束。优先用 anchor（首次发生的本地日期，测试可注入），
    // 缺失时回退 created_at；datetime()/date() 兼容历史数据里的 `Z` / `+00:00`。
    //
    // 还要包含「本期有完成事件、但首次发生日在窗口之后」的规则：用户提前完成
    // 未来期次是合法操作，不能因为任务当前 due_at 在窗口外就把规则行漏掉——
    // 否则后续校验会把它误判成「规则已解除」，凭空标记统计不完整。
    let recurring = {
        let mut stmt = tx.prepare(
            "SELECT t.id, t.due_at, t.created_at, rr.freq, rr.interval, rr.by_weekday,
                    rr.by_monthday, rr.by_setpos, rr.until, rr.anchor
             FROM tasks t
             JOIN recurrence_rules rr ON rr.id = t.recurrence_rule_id
             WHERE (
                     (CASE WHEN trim(rr.anchor) <> '' THEN rr.anchor ELSE date(t.created_at, 'localtime') END)
                       < ?1
                     OR EXISTS (
                       SELECT 1 FROM task_completion_events e
                       WHERE e.task_id = t.id
                         AND e.completed_at >= ?3 AND e.completed_at < ?4
                     )
                   )
               AND (rr.until IS NULL OR trim(rr.until) = '' OR datetime(rr.until) >= datetime(?2))",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![end_local_date, start_iso, start_iso, end_iso],
            |row| {
                let by_weekday_raw: String = row.get(5)?;
                Ok(RecurringTaskRow {
                    task_id: row.get(0)?,
                    due_at: row.get(1)?,
                    created_at: row.get(2)?,
                    freq: row.get(3)?,
                    interval: row.get(4)?,
                    by_weekday: serde_json::from_str(&by_weekday_raw).unwrap_or_default(),
                    by_monthday: row.get(6)?,
                    by_setpos: row.get(7)?,
                    until: row.get(8)?,
                    anchor: row.get(9)?,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    tx.commit()?;
    Ok((events, tasks, completed_with_events, recurring))
}

/// 本地日期 + 时刻 → 本地时间；DST 跳变中不存在的时刻返回 None（该期次跳过，
/// 与 `local_midnight` 的防御策略一致，不让统计查询 panic）。
fn local_at(date: NaiveDate, time: chrono::NaiveTime) -> Option<DateTime<Local>> {
    match Local.from_local_datetime(&date.and_time(time)) {
        MappedLocalTime::Single(dt) => Some(dt),
        MappedLocalTime::Ambiguous(earliest, _) => Some(earliest),
        MappedLocalTime::None => None,
    }
}

/// 从 `anchor` 开始按 `interval` 对齐，返回不早于 `from` 的第一个网格日期。
fn first_on_grid(anchor: NaiveDate, interval: i64, from: NaiveDate) -> NaiveDate {
    if from <= anchor {
        return anchor;
    }
    let interval = interval.max(1);
    let diff = (from - anchor).num_days();
    let steps = (diff + interval - 1) / interval;
    shift_days(anchor, steps * interval)
}

fn last_day_of_month(year: i32, month0: i32) -> NaiveDate {
    let (next_year, next_month0) = if month0 >= 11 {
        (year + 1, 0)
    } else {
        (year, month0 + 1)
    };
    shift_days(month_start(next_year, next_month0), -1)
}

/// 某月第 N 个（或最后一个）命中 `by_weekday` 的日期；与重复任务引擎同义。
fn nth_weekday_in_month(year: i32, month0: i32, by_weekday: &[u32], pos: i32) -> Option<NaiveDate> {
    if pos == 0 {
        return None;
    }
    let mut hits: Vec<NaiveDate> = Vec::new();
    let last = last_day_of_month(year, month0);
    let mut date = month_start(year, month0);
    while date <= last {
        if by_weekday.contains(&crate::recurrence::weekday_num(date)) {
            hits.push(date);
        }
        date = shift_days(date, 1);
    }
    if pos == -1 {
        hits.last().copied()
    } else {
        hits.get(pos.unsigned_abs() as usize - 1).copied()
    }
}

/// 计算某个重复任务在**已经到期**（<= now）且落在本期窗口内的规则期次。
///
/// 只用于完整性判断，不参与完成率分母：分母仍只统计仍可还原的期次，避免把
/// 推算出来的历史当作事实。返回 UTC 毫秒时间戳集合，便于与事件 / 任务行对齐。
fn expected_past_occurrences(
    row: &RecurringTaskRow,
    window_start: NaiveDate,
    window_end: NaiveDate,
    now_local: DateTime<Local>,
) -> HashSet<i64> {
    let mut occurrences = HashSet::new();
    let Some(due_utc) = row.due_at.as_deref().and_then(parse_utc) else {
        return occurrences;
    };
    let due_local = due_utc.with_timezone(&Local);
    let time = due_local.time();
    let anchor = NaiveDate::parse_from_str(&row.anchor, "%Y-%m-%d")
        .ok()
        .or_else(|| parse_utc(&row.created_at).map(|v| v.with_timezone(&Local).date_naive()));
    let Some(anchor) = anchor else {
        return occurrences;
    };
    let until = row.until.as_deref().and_then(parse_utc);
    let interval = row.interval.max(1);
    let window_start_utc = local_midnight(window_start);
    let window_end_utc = local_midnight(window_end);

    let mut push = |date: NaiveDate| {
        if date < anchor || date < window_start || date >= window_end {
            return;
        }
        let Some(candidate_local) = local_at(date, time) else {
            return;
        };
        if candidate_local > now_local {
            return;
        }
        let candidate_utc = candidate_local.with_timezone(&Utc);
        if candidate_utc < window_start_utc || candidate_utc >= window_end_utc {
            return;
        }
        if let Some(until) = until {
            if candidate_utc > until {
                return;
            }
        }
        occurrences.insert(candidate_utc.timestamp_millis());
    };

    match row.freq.as_str() {
        "daily" => {
            let mut date = first_on_grid(anchor, interval, window_start);
            while date < window_end {
                push(date);
                date = shift_days(date, interval);
            }
        }
        "weekly" => {
            if row.by_weekday.is_empty() {
                return occurrences;
            }
            let mut date = anchor.max(window_start);
            while date < window_end {
                let weeks = (date - anchor).num_weeks();
                if weeks >= 0
                    && weeks % interval == 0
                    && row
                        .by_weekday
                        .contains(&crate::recurrence::weekday_num(date))
                {
                    push(date);
                }
                date = shift_days(date, 1);
            }
        }
        "monthly" => {
            let anchor_total = anchor.year() as i64 * 12 + anchor.month0() as i64;
            let start_total = window_start.year() as i64 * 12 + window_start.month0() as i64;
            let end_total = window_end.year() as i64 * 12 + window_end.month0() as i64;
            let scan_total = anchor_total.max(start_total);
            let diff = scan_total - anchor_total;
            let mut k = (diff + interval - 1) / interval;
            loop {
                let total = anchor_total + k * interval;
                if total >= end_total {
                    break;
                }
                let year = total.div_euclid(12) as i32;
                let month0 = total.rem_euclid(12) as i32;
                let date = if let Some(pos) = row.by_setpos.filter(|_| !row.by_weekday.is_empty()) {
                    nth_weekday_in_month(year, month0, &row.by_weekday, pos)
                } else {
                    let day = row.by_monthday.unwrap_or(anchor.day()).clamp(1, 31);
                    let last = last_day_of_month(year, month0);
                    NaiveDate::from_ymd_opt(year, month0 as u32 + 1, day.min(last.day()))
                };
                if let Some(date) = date {
                    push(date);
                }
                k += 1;
            }
        }
        _ => {}
    }

    occurrences
}

/// 判断本期分母是否完整。
///
/// 只对**可还原**的到期期次做校对：规则推算出的、已经到期的期次必须能在
/// 完成任务行或完成事件里找到。找不到就说明该期次被调度器自动推进、停机补偿
/// 跳过或用户改期抹掉了，本期 `due` 分母偏小，完成率 / 逾期率可能偏高。
fn evaluate_history_complete(
    recurring: &[RecurringTaskRow],
    events: &[EventRow],
    tasks: &[DueTaskRow],
    window_start: NaiveDate,
    window_end: NaiveDate,
    now_local: DateTime<Local>,
) -> bool {
    let mut reconstructed: HashMap<String, HashSet<i64>> = HashMap::new();
    for event in events {
        if let Some(due) = &event.due_at {
            if let Some(due_utc) = parse_utc(due) {
                reconstructed
                    .entry(event.task_id.clone())
                    .or_default()
                    .insert(due_utc.timestamp_millis());
            }
        }
    }
    for task in tasks {
        if let Some(due_utc) = parse_utc(&task.due_at) {
            reconstructed
                .entry(task.id.clone())
                .or_default()
                .insert(due_utc.timestamp_millis());
        }
    }

    let rule_task_ids: HashSet<&str> = recurring.iter().map(|row| row.task_id.as_str()).collect();
    // 规则已解除但仍有重复完成事件：后续期次无法再按规则校验/还原。
    for event in events {
        if event.kind == "recurring" && !rule_task_ids.contains(event.task_id.as_str()) {
            return false;
        }
    }

    for row in recurring {
        if row.due_at.is_none() {
            // 当前无截止时间，却存在重复完成事件：曾经发生过的期次已无规则
            // 起点可供还原（例如清空截止时间后仍保留历史）。
            if events
                .iter()
                .any(|event| event.task_id == row.task_id && event.kind == "recurring")
            {
                return false;
            }
            continue;
        }
        let known = reconstructed.get(&row.task_id);
        for ms in expected_past_occurrences(row, window_start, window_end, now_local) {
            if known.map_or(true, |set| !set.contains(&ms)) {
                return false;
            }
        }
    }

    true
}

/// 按固定「当前本地时间」计算统计（测试可注入时间）。
pub(crate) fn report_at(
    db: &Db,
    kind: RangeKind,
    now_local: DateTime<Local>,
) -> AppResult<TaskAnalytics> {
    let today = now_local.date_naive();
    let now_utc = now_local.with_timezone(&Utc);
    let buckets = trend_buckets(kind, today);
    let bounds: Vec<(DateTime<Utc>, DateTime<Utc>)> = buckets
        .iter()
        .map(|b| (local_midnight(b.start), local_midnight(b.end)))
        .collect();
    let (window_start, window_end) = (bounds[0].0, bounds[bounds.len() - 1].1);

    let (events, tasks, completed_with_events, recurring) =
        db.with_read(|conn| load_rows(conn, window_start, window_end))?;

    let mut stats: Vec<BucketStat> = vec![BucketStat::default(); buckets.len()];
    let mut category_counts: HashMap<String, i64> = HashMap::new();
    let mut priority_counts: HashMap<u8, i64> = HashMap::new();

    // 1) 完成事件：按 completed_at 落桶。只有最后一桶（本期）参与分类/优先级分布。
    for event in &events {
        let Some(completed) = parse_utc(&event.completed_at) else {
            continue;
        };
        let Some(idx) = bucket_index(&bounds, completed) else {
            continue;
        };
        let bucket = &mut stats[idx];
        bucket.completed += 1;
        if event.kind == "recurring" {
            bucket.recurring_completed += 1;
        }
        if idx + 1 == stats.len() {
            let category = normalize_category(&event.category);
            *category_counts.entry(category).or_default() += 1;
            let priority = event.priority.clamp(0, 3) as u8;
            *priority_counts.entry(priority).or_default() += 1;
        }
    }

    // 2) 到期发生次数：事件保存历史期次的 due 快照；任务当前行只补充
    //    「没有完成事件」的已完成任务与所有未完成任务，按 (task_id, due_at) 去重。
    let mut occurrences: HashMap<(String, String), Option<String>> = HashMap::new();
    for event in &events {
        if let Some(due) = &event.due_at {
            let key = (event.task_id.clone(), due.clone());
            match occurrences.get_mut(&key) {
                Some(slot) => {
                    // 同一 (task_id, due_at) 可能出现多条事件（并发双击、回填 + 用户）。
                    // 取最早的完成时间，保证「是否逾期」不随查询返回顺序漂移。
                    let earlier = slot
                        .as_deref()
                        .map_or(true, |prev| event.completed_at.as_str() < prev);
                    if earlier {
                        *slot = Some(event.completed_at.clone());
                    }
                }
                None => {
                    occurrences.insert(key, Some(event.completed_at.clone()));
                }
            }
        }
    }
    for task in &tasks {
        let key = (task.id.clone(), task.due_at.clone());
        if task.status == "completed" {
            // 已完成任务的 due_at 可能在完成后被编辑；有事件时以事件快照为准。
            // 仅在完全没有事件（例如从旧备份恢复）时才回退到任务当前行。
            if !completed_with_events.contains(&task.id) {
                occurrences
                    .entry(key)
                    .or_insert_with(|| task.completed_at.clone());
            }
        } else {
            // 仍未完成：任务当前行优先于可能残留的旧事件（重开后未清理的历史事件）。
            occurrences.insert(key, None);
        }
    }
    for ((_, due), completed_at) in &occurrences {
        let Some(due_at) = parse_utc(due) else {
            continue;
        };
        let Some(idx) = bucket_index(&bounds, due_at) else {
            continue;
        };
        let bucket = &mut stats[idx];
        bucket.due += 1;
        match completed_at.as_deref().and_then(parse_utc) {
            Some(completed) => {
                bucket.due_completed += 1;
                if completed > due_at {
                    bucket.due_overdue += 1;
                }
            }
            None => {
                // 仍未完成：截止时间已过才算逾期（本期尚未到期的任务不算）
                if due_at < now_utc {
                    bucket.due_overdue += 1;
                }
            }
        }
    }

    let summary_bucket = &stats[stats.len() - 1];
    let summary = AnalyticsSummary {
        completed: summary_bucket.completed,
        recurring_completed: summary_bucket.recurring_completed,
        due: summary_bucket.due,
        due_completed: summary_bucket.due_completed,
        due_overdue: summary_bucket.due_overdue,
        completion_rate: rate(summary_bucket.due_completed, summary_bucket.due),
        overdue_rate: rate(summary_bucket.due_overdue, summary_bucket.due),
    };

    let trend: Vec<TrendPoint> = buckets
        .iter()
        .zip(stats.iter())
        .map(|(bucket, stat)| {
            let (start, end) = (local_midnight(bucket.start), local_midnight(bucket.end));
            TrendPoint {
                key: bucket.start.format("%Y-%m-%d").to_string(),
                label: bucket_label(kind, bucket, today.year()),
                start: start.to_rfc3339(),
                end: end.to_rfc3339(),
                completed: stat.completed,
                due: stat.due,
                due_completed: stat.due_completed,
                due_overdue: stat.due_overdue,
                completion_rate: rate(stat.due_completed, stat.due),
                overdue_rate: rate(stat.due_overdue, stat.due),
            }
        })
        .collect();

    let total_completed = summary.completed.max(1) as f64;
    let mut by_category: Vec<CategoryStat> = category_counts
        .into_iter()
        .map(|(category, completed)| CategoryStat {
            category,
            completed,
            share: if summary.completed > 0 {
                completed as f64 / total_completed
            } else {
                0.0
            },
        })
        .collect();
    by_category.sort_by(|a, b| {
        b.completed
            .cmp(&a.completed)
            .then(a.category.cmp(&b.category))
    });

    let by_priority: Vec<PriorityStat> = (0u8..=3)
        .map(|priority| {
            let completed = priority_counts.get(&priority).copied().unwrap_or(0);
            PriorityStat {
                priority,
                completed,
                share: if summary.completed > 0 {
                    completed as f64 / total_completed
                } else {
                    0.0
                },
            }
        })
        .collect();

    let (range_start, range_end) = range_window(kind, today);
    // 完整性只针对本期；趋势桶的历史缺失不在本字段里逐桶声明。
    let history_complete = evaluate_history_complete(
        &recurring,
        &events,
        &tasks,
        range_start,
        range_end,
        now_local,
    );

    Ok(TaskAnalytics {
        range: kind.key(),
        range_label: kind.label(),
        range_start: range_start.format("%Y-%m-%d").to_string(),
        range_end: range_end.format("%Y-%m-%d").to_string(),
        generated_at: crate::agents::now_iso(),
        summary,
        trend,
        by_category,
        by_priority,
        history_complete,
        definitions: DEFINITIONS,
    })
}

/// 指标口径（唯一来源：前端原样展示）。
pub const DEFINITIONS: AnalyticsDefinitions = AnalyticsDefinitions {
    completed: "完成数量：范围内真实发生的完成动作。普通任务每次勾选完成记 1 次；重复任务每完成一期记 1 次（任务本身保持未完成并推进到下一期）；同一任务的同一期次只计 1 次。",
    completion_rate: "完成率 = 本期到期任务中已完成的数量 / 本期到期任务数。分母含本期尚未到期的任务，因此本期未结束时它是「当前进度」而不是最终结果；分母只统计仍可还原的到期期次，history_complete=false 时实际到期期次可能更多、完成率可能偏高。",
    overdue_rate: "逾期率 = 本期到期任务中逾期的数量 / 本期到期任务数。逾期指：完成时间晚于截止时间，或仍未完成且截止时间已过（本期尚未到期的任务不算逾期）；分母只统计仍可还原的到期期次，history_complete=false 时可能偏高。",
    trend: "趋势按本地日历分桶：日视图近 14 天、周视图近 12 周（周一为一周起点）、月视图近 12 个月。完成与逾期同为计数，共用刻度；历史分桶同样受下面「历史限制」影响。",
    distribution: "分类 / 优先级分布按「完成事件发生时的快照」统计；分类为空显示为「未分类」。这是完成分布，不代表各分类的整体效率。",
    history: "历史限制：完成数量来自真实完成事件（普通任务每次完成记 1 次，重复任务每完成一期记 1 次）；到期分母只统计仍可还原的期次。重复任务被调度器自动推进、停机/休眠后补偿跳过、或用户主动改期时，被跳过的期次没有独立记录，无法可靠还原，也不会伪造回填；检测到这类缺失时 history_complete=false，前端会标注「不完整统计」。升级前重复任务的历史完成期次同样无法还原；升级前已完成的普通任务按数据库中真实的 completed_at 回填。",
};

/// 供命令层调用：读取任务统计。
pub fn report(db: &Db, range: Option<&str>) -> AppResult<TaskAnalytics> {
    let kind = RangeKind::parse(range)?;
    report_at(db, kind, Local::now())
}

/// 写入一次完成事件。调用方保证 `completed_at` 是本次真实完成时间。
///
/// `kind`：`once`（普通任务）或 `recurring`（重复任务的某一期）。
///
/// 幂等约束：同一任务、同一 `kind`、同一非空 `due_at` 只保留一条事件（与迁移里的
/// 部分唯一索引一致）。并发双击、「回填 + 用户」同时出现时第二条同源事件被忽略而
/// 不是重复计数。`due_at` 为 NULL 时不参与去重：重复任务如果曾无截止日期，推进后
/// 每期都会写入新的 `due_at`，若把 NULL 也当同一期次，会把后续期次全部吞掉；
/// 真正的并发保护由调度器推进函数的期次 CAS 负责。
pub(crate) fn record_completion(
    conn: &Connection,
    task_id: &str,
    completed_at: &str,
    due_at: Option<&str>,
    category: &str,
    priority: i64,
    kind: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO task_completion_events
           (id, task_id, completed_at, due_at, category, priority, origin, kind, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'user', ?7, ?8
         WHERE ?4 IS NULL OR NOT EXISTS (
           SELECT 1 FROM task_completion_events
           WHERE task_id = ?2 AND kind = ?7 AND due_at = ?4
         )",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            task_id,
            completed_at,
            due_at,
            category,
            priority.clamp(0, 3),
            kind,
            crate::agents::now_iso(),
        ],
    )?;
    Ok(())
}

/// 取消一次完成（用户把任务重新打开）：删除对应完成时间的事件，
/// 保持「完成数量」与任务当前状态一致，避免重开后仍计入历史完成。
///
/// 不限定 `origin`：升级回填事件（`backfill`）与用户事件共用 `tasks.completed_at`，
/// 若只删 `user`，升级前完成的普通任务被重新打开后仍会计入历史，重开后再完成同一次
/// 还会出现两个完成数。
pub(crate) fn remove_completion(
    conn: &Connection,
    task_id: &str,
    completed_at: &str,
) -> AppResult<()> {
    conn.execute(
        "DELETE FROM task_completion_events
         WHERE task_id = ?1 AND completed_at = ?2",
        rusqlite::params![task_id, completed_at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::tasks::{create_task_inner, toggle_task_inner, TaskInput};
    use crate::recurrence::RecurrenceRuleInput;

    /// 建表由迁移 v24 完成（`tmp/acceptance/task-analytics/schema.sql` 已落地到 MIGRATIONS）。
    fn setup() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn fixed_now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 11, 4, 10, 30, 0).unwrap()
    }

    fn local_iso(y: i32, m: u32, d: u32, h: u32, min: u32) -> String {
        Local
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .unwrap()
            .with_timezone(&Utc)
            .to_rfc3339()
    }

    /// 依赖真实 `toggle_task_inner`（完成时间取当前时钟）的用例必须按「今天」取日期：
    /// 写死具体日期会在第二天起把完成事件排除在 `report_at` 的当日窗口外。
    fn today_at(hour: u32, minute: u32) -> String {
        let date = Local::now().date_naive();
        Local
            .from_local_datetime(&date.and_hms_opt(hour, minute, 0).unwrap())
            .unwrap()
            .with_timezone(&Utc)
            .to_rfc3339()
    }

    fn day_offset(days: i64, hour: u32, minute: u32) -> String {
        let date = Local::now().date_naive() + chrono::Duration::days(days);
        Local
            .from_local_datetime(&date.and_hms_opt(hour, minute, 0).unwrap())
            .unwrap()
            .with_timezone(&Utc)
            .to_rfc3339()
    }

    fn task_input(
        title: &str,
        due: Option<String>,
        recurrence: Option<RecurrenceRuleInput>,
    ) -> TaskInput {
        TaskInput {
            title: title.to_string(),
            due_at: Some(due),
            recurrence: Some(recurrence),
            ..Default::default()
        }
    }

    fn daily() -> RecurrenceRuleInput {
        RecurrenceRuleInput {
            freq: "daily".into(),
            interval: 1,
            by_weekday: vec![],
            by_monthday: None,
            by_setpos: None,
        }
    }

    fn count_events(db: &Db) -> i64 {
        db.with_read(|conn| {
            Ok(
                conn.query_row("SELECT COUNT(*) FROM task_completion_events", [], |r| {
                    r.get(0)
                })?,
            )
        })
        .unwrap()
    }

    /// 插入一条无截止时间的待办任务（FK 目标），用于只验证完成事件口径的场景。
    fn insert_pending_task(db: &Db, id: &str) {
        db.with_conn(|conn| {
            let now = crate::agents::now_iso();
            conn.execute(
                "INSERT INTO tasks
                   (id, title, description, priority, status, category, tags, due_at, remind_at,
                    advance_minutes, recurrence_rule_id, created_at, updated_at, completed_at)
                 VALUES (?1, ?1, '', 2, 'pending', '', '[]', NULL, NULL, 0, NULL, ?2, ?2, NULL)",
                rusqlite::params![id, now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    fn record_at(db: &Db, id: &str, completed_at: &str) {
        db.with_conn(|conn| record_completion(conn, id, completed_at, None, "", 2, "once"))
            .unwrap();
    }

    fn record_at_due(db: &Db, id: &str, completed_at: &str, due_at: &str) {
        db.with_conn(|conn| record_completion(conn, id, completed_at, Some(due_at), "", 2, "once"))
            .unwrap();
    }

    #[test]
    fn unknown_range_is_rejected() {
        assert!(RangeKind::parse(Some("year")).is_err());
        assert_eq!(RangeKind::parse(None).unwrap(), RangeKind::Day);
        assert_eq!(RangeKind::parse(Some("week")).unwrap(), RangeKind::Week);
    }

    #[test]
    fn empty_db_has_null_rates_and_zero_buckets() {
        let db = setup();
        let report = report_at(&db, RangeKind::Day, fixed_now()).unwrap();
        assert_eq!(report.range, "day");
        assert_eq!(report.summary.completed, 0);
        assert_eq!(report.summary.due, 0);
        assert_eq!(report.summary.completion_rate, None);
        assert_eq!(report.summary.overdue_rate, None);
        assert_eq!(report.trend.len(), 14);
        assert!(report.trend.iter().all(|p| p.completed == 0 && p.due == 0));
        assert!(report.by_category.is_empty());
        assert_eq!(report.by_priority.len(), 4);
        assert!(report.by_priority.iter().all(|p| p.completed == 0));
        assert!(report.definitions.completion_rate.contains("分母"));
        assert!(report.history_complete, "空库没有缺失期次");
    }

    #[test]
    fn completing_task_records_event_and_full_rate() {
        let db = setup();
        // 截止时间放到当天末尾，避免真实时钟决定「是否晚于截止」而影响完成率断言。
        let today_due = today_at(23, 59);
        let task = create_task_inner(&db, task_input("写报告", Some(today_due), None)).unwrap();
        toggle_task_inner(&db, &task.id).unwrap();

        assert_eq!(count_events(&db), 1);
        let report = report_at(&db, RangeKind::Day, Local::now()).unwrap();
        assert_eq!(report.summary.completed, 1);
        assert_eq!(report.summary.recurring_completed, 0);
        assert_eq!(report.summary.due, 1);
        assert_eq!(report.summary.due_completed, 1);
        assert_eq!(report.summary.completion_rate, Some(1.0));
    }

    #[test]
    fn reopening_removes_completion_event() {
        let db = setup();
        let task = create_task_inner(
            &db,
            task_input("可撤销", Some(local_iso(2026, 11, 4, 9, 0)), None),
        )
        .unwrap();
        toggle_task_inner(&db, &task.id).unwrap();
        assert_eq!(count_events(&db), 1);
        toggle_task_inner(&db, &task.id).unwrap(); // 重新打开
        assert_eq!(count_events(&db), 0);
        let report = report_at(&db, RangeKind::Day, fixed_now()).unwrap();
        assert_eq!(report.summary.completed, 0);
        assert_eq!(report.summary.due, 1);
        assert_eq!(report.summary.due_completed, 0);
        assert_eq!(report.summary.completion_rate, Some(0.0));
    }

    #[test]
    fn duplicate_completion_for_same_occurrence_is_ignored() {
        let db = setup();
        let due = local_iso(2026, 11, 4, 9, 0);
        let task = create_task_inner(&db, task_input("同一期次", Some(due.clone()), None)).unwrap();
        record_at_due(&db, &task.id, &local_iso(2026, 11, 4, 10, 0), &due);
        record_at_due(&db, &task.id, &local_iso(2026, 11, 4, 10, 1), &due);
        assert_eq!(
            count_events(&db),
            1,
            "同一 (task_id, due_at) 只能有一条用户事件"
        );
    }

    #[test]
    fn reopening_removes_backfilled_completion_event() {
        let db = setup();
        let due = local_iso(2026, 11, 3, 9, 0);
        let completed_at = local_iso(2026, 11, 3, 10, 0);
        let task =
            create_task_inner(&db, task_input("升级前完成", Some(due.clone()), None)).unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tasks SET status = 'completed', completed_at = ?1 WHERE id = ?2",
                rusqlite::params![completed_at, task.id],
            )?;
            conn.execute(
                "INSERT INTO task_completion_events
                   (id, task_id, completed_at, due_at, category, priority, origin, kind, created_at)
                 VALUES (?1, ?2, ?3, ?4, '', 2, 'backfill', 'once', ?3)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), task.id, completed_at, due],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        assert_eq!(count_events(&db), 1);

        toggle_task_inner(&db, &task.id).unwrap(); // 重新打开
        assert_eq!(count_events(&db), 0, "回填事件也必须随重新打开撤销");
    }

    #[test]
    fn editing_due_after_completion_does_not_double_count_due_occurrence() {
        let db = setup();
        let original_due = local_iso(2026, 11, 2, 9, 0);
        let completed_at = local_iso(2026, 11, 4, 10, 0);
        let task =
            create_task_inner(&db, task_input("改期", Some(original_due.clone()), None)).unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tasks SET status = 'completed', completed_at = ?1 WHERE id = ?2",
                rusqlite::params![completed_at, task.id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        record_at_due(&db, &task.id, &completed_at, &original_due);

        // 完成后修改截止时间：到期发生仍以完成事件的 due 快照为准。
        let edit = TaskInput {
            title: "改期".into(),
            due_at: Some(Some(local_iso(2026, 11, 4, 9, 0))),
            ..Default::default()
        };
        crate::commands::tasks::update_task_inner(&db, &task.id, edit).unwrap();

        let report = report_at(&db, RangeKind::Week, fixed_now()).unwrap();
        assert_eq!(report.summary.due, 1, "同一完成事实只能对应一次到期发生");
        assert_eq!(report.summary.due_completed, 1);
    }

    #[test]
    fn recurring_completion_records_each_occurrence_without_completing_task() {
        let db = setup();
        let yesterday = Local.with_ymd_and_hms(2026, 11, 3, 9, 0, 0).unwrap();
        let task = create_task_inner(
            &db,
            task_input(
                "每日站会",
                Some(yesterday.with_timezone(&Utc).to_rfc3339()),
                Some(daily()),
            ),
        )
        .unwrap();

        toggle_task_inner(&db, &task.id).unwrap();
        toggle_task_inner(&db, &task.id).unwrap();

        let after = crate::commands::tasks::get_task(&db, &task.id).unwrap();
        assert_eq!(after.status, "pending", "重复任务完成后必须保持 pending");
        assert!(after.due_at.is_some());
        assert_eq!(count_events(&db), 2);
        let report = report_at(&db, RangeKind::Week, fixed_now()).unwrap();
        assert_eq!(report.summary.completed, 2);
        assert_eq!(report.summary.recurring_completed, 2);
    }

    /// v0.10 原子性 #1：重复任务正常完成 → 期次推进且恰好一条「本期」事件。
    #[test]
    fn recurring_completion_writes_one_event_for_consumed_occurrence() {
        let db = setup();
        let due = local_iso(2026, 11, 4, 23, 59);
        let task = create_task_inner(
            &db,
            task_input("每日复盘", Some(due.clone()), Some(daily())),
        )
        .unwrap();

        toggle_task_inner(&db, &task.id).unwrap();

        let after = crate::commands::tasks::get_task(&db, &task.id).unwrap();
        assert_eq!(after.status, "pending");
        assert_ne!(
            after.due_at.as_deref(),
            Some(due.as_str()),
            "应推进到下一期"
        );
        let rows: Vec<(String, Option<String>, String)> = db
            .with_read(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT completed_at, due_at, kind FROM task_completion_events WHERE task_id = ?1",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![task.id], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(rows.len(), 1, "一期只允许一条完成事件");
        assert_eq!(
            rows[0].1.as_deref(),
            Some(due.as_str()),
            "事件归属被消耗的期次"
        );
        assert_eq!(rows[0].2, "recurring");
    }

    /// v0.10 原子性 #2（失败注入）：事件插入失败时，期次推进与提醒重建必须整体回滚。
    #[test]
    fn completion_event_failure_rolls_back_advance_and_reminders() {
        let db = setup();
        let due = local_iso(2026, 11, 4, 23, 59);
        let task = create_task_inner(
            &db,
            task_input("每日站会", Some(due.clone()), Some(daily())),
        )
        .unwrap();
        let reminders_before: Vec<(String, String)> = db
            .with_read(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT remind_at, kind FROM task_reminders WHERE task_id = ?1 ORDER BY remind_at",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![task.id], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .unwrap();
        assert!(!reminders_before.is_empty(), "前置条件：任务应有待触发提醒");

        // 真实失败注入：事件表插入时 ABORT，模拟「第 4 步写入失败」。
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER inject_completion_failure BEFORE INSERT ON task_completion_events
                 BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END;",
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let err = toggle_task_inner(&db, &task.id).unwrap_err();
        assert!(
            format!("{err}").contains("injected"),
            "应返回真实失败原因: {err}"
        );

        let after = crate::commands::tasks::get_task(&db, &task.id).unwrap();
        assert_eq!(
            after.due_at.as_deref(),
            Some(due.as_str()),
            "任务期次必须回滚"
        );
        assert_eq!(count_events(&db), 0, "不得留下半条完成事实");
        let reminders_after: Vec<(String, String)> = db
            .with_read(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT remind_at, kind FROM task_reminders WHERE task_id = ?1 ORDER BY remind_at",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![task.id], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(reminders_after, reminders_before, "提醒必须回滚到原期次");

        // 回滚后事务仍可正常提交：移除注入后重试成功且只有一条事件。
        db.with_conn(|conn| {
            conn.execute_batch("DROP TRIGGER inject_completion_failure;")?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        toggle_task_inner(&db, &task.id).unwrap();
        assert_eq!(count_events(&db), 1);
    }

    /// v0.10 原子性 #3：同一期次被并发/重放推进时，后到者必须 Conflict 且不改数据。
    #[test]
    fn replay_with_same_occurrence_conflicts_without_advancing() {
        use crate::scheduler::{advance_recurrence_tx, AdvanceOutcome};
        let db = setup();
        let due = local_iso(2026, 11, 4, 23, 59);
        let task = create_task_inner(
            &db,
            task_input("每日站会", Some(due.clone()), Some(daily())),
        )
        .unwrap();

        let first = db
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                let out = advance_recurrence_tx(&tx, &task.id, Some(due.as_str()), &Utc::now())?;
                tx.commit()?;
                Ok(out)
            })
            .unwrap();
        let expected_to = match first {
            AdvanceOutcome::Advanced { to_due, .. } => to_due,
            other => panic!("首次推进应成功: {other:?}"),
        };

        // 重放同一个 expected_due（模拟第二个并发请求持有旧快照）
        let second = db
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                let out = advance_recurrence_tx(&tx, &task.id, Some(due.as_str()), &Utc::now())?;
                tx.commit()?;
                Ok(out)
            })
            .unwrap();
        assert_eq!(second, AdvanceOutcome::Conflict, "同一期次不得推进两次");

        let after = crate::commands::tasks::get_task(&db, &task.id).unwrap();
        assert_eq!(
            after.due_at.as_deref(),
            Some(expected_to.as_str()),
            "期次保持不变"
        );
    }

    /// v0.10 原子性 #5：自动到期推进（调度器路径）不是用户完成，不得写完成事件。
    #[test]
    fn auto_advance_does_not_create_user_events() {
        use crate::scheduler::advance_recurrence_tx;
        let db = setup();
        let due = local_iso(2026, 11, 4, 23, 59);
        let task = create_task_inner(
            &db,
            task_input("每日站会", Some(due.clone()), Some(daily())),
        )
        .unwrap();

        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let _ = advance_recurrence_tx(&tx, &task.id, Some(due.as_str()), &Utc::now())?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        assert_eq!(count_events(&db), 0, "自动推进不得伪造成用户完成");
        let after = crate::commands::tasks::get_task(&db, &task.id).unwrap();
        assert_ne!(after.due_at.as_deref(), Some(due.as_str()));
    }

    #[test]
    fn late_completion_counts_as_overdue() {
        let db = setup();
        let due = local_iso(2026, 11, 2, 9, 0);
        let task = create_task_inner(&db, task_input("迟交", Some(due), None)).unwrap();
        toggle_task_inner(&db, &task.id).unwrap();

        let report = report_at(&db, RangeKind::Week, fixed_now()).unwrap();
        assert_eq!(report.summary.completed, 1);
        assert_eq!(report.summary.due, 1);
        assert_eq!(report.summary.due_completed, 1);
        assert_eq!(report.summary.due_overdue, 1);
        assert_eq!(report.summary.completion_rate, Some(1.0));
        assert_eq!(report.summary.overdue_rate, Some(1.0));
    }

    #[test]
    fn pending_past_due_counts_as_overdue_but_future_due_does_not() {
        let db = setup();
        create_task_inner(
            &db,
            task_input("逾期未做", Some(local_iso(2026, 11, 3, 9, 0)), None),
        )
        .unwrap();
        create_task_inner(
            &db,
            task_input("今晚到期", Some(local_iso(2026, 11, 4, 23, 0)), None),
        )
        .unwrap();

        // 本周窗口同时覆盖 11-03（已过）与 11-04（未到），分母固定为「本周到期任务数」。
        let report = report_at(&db, RangeKind::Week, fixed_now()).unwrap();
        assert_eq!(report.summary.completed, 0);
        assert_eq!(report.summary.due, 2);
        assert_eq!(report.summary.due_completed, 0);
        assert_eq!(report.summary.due_overdue, 1);
        assert_eq!(report.summary.overdue_rate, Some(0.5));
    }

    #[test]
    fn local_day_boundary_is_not_utc() {
        let db = setup();
        insert_pending_task(&db, "early");
        insert_pending_task(&db, "late");
        // 本地 00:30 → UTC 前一天 16:30，必须计入「今日」。
        record_at(&db, "early", &local_iso(2026, 11, 4, 0, 30));
        // 本地前一天 23:30 → 不计入「今日」。
        record_at(&db, "late", &local_iso(2026, 11, 3, 23, 30));

        let day = report_at(&db, RangeKind::Day, fixed_now()).unwrap();
        assert_eq!(day.summary.completed, 1);
        let week = report_at(&db, RangeKind::Week, fixed_now()).unwrap();
        assert_eq!(week.summary.completed, 2);
    }

    #[test]
    fn month_and_week_windows_align_to_local_calendar() {
        let db = setup();
        // 2026-11-04 是周三；本周起点 2026-11-02（周一）。
        insert_pending_task(&db, "prev-month");
        insert_pending_task(&db, "this-week");
        record_at(&db, "prev-month", &local_iso(2026, 10, 31, 9, 0));
        record_at(&db, "this-week", &local_iso(2026, 11, 3, 9, 0));

        let month = report_at(&db, RangeKind::Month, fixed_now()).unwrap();
        assert_eq!(month.summary.completed, 1, "10-31 不属于 11 月");
        let week = report_at(&db, RangeKind::Week, fixed_now()).unwrap();
        assert_eq!(week.summary.completed, 1, "11-03 属于本周");
        let day = report_at(&db, RangeKind::Day, fixed_now()).unwrap();
        assert_eq!(day.summary.completed, 0);
    }

    #[test]
    fn distribution_uses_completion_snapshot() {
        let db = setup();
        let a = task_input("A", Some(today_at(9, 0)), None);
        let mut a = a;
        a.category = Some("工作".into());
        a.priority = Some(0);
        let task_a = create_task_inner(&db, a).unwrap();
        let mut b = task_input("B", Some(today_at(9, 30)), None);
        b.category = Some("工作".into());
        b.priority = Some(0);
        let task_b = create_task_inner(&db, b).unwrap();
        let task_c = create_task_inner(&db, task_input("C", Some(today_at(10, 0)), None)).unwrap();

        toggle_task_inner(&db, &task_a.id).unwrap();
        toggle_task_inner(&db, &task_b.id).unwrap();
        toggle_task_inner(&db, &task_c.id).unwrap();

        let report = report_at(&db, RangeKind::Day, Local::now()).unwrap();
        let work = report
            .by_category
            .iter()
            .find(|c| c.category == "工作")
            .unwrap();
        assert_eq!(work.completed, 2);
        assert!((work.share - 2.0 / 3.0).abs() < 1e-9);
        assert!(report
            .by_category
            .iter()
            .any(|c| c.category == "未分类" && c.completed == 1));
        assert_eq!(report.by_priority[0].completed, 2);
        assert_eq!(report.by_priority[2].completed, 1);

        // 完成后再改分类，不影响已完成事件的历史快照。
        let mut edit = TaskInput {
            title: "A".into(),
            category: Some("生活".into()),
            ..Default::default()
        };
        edit.priority = Some(1);
        crate::commands::tasks::update_task_inner(&db, &task_a.id, edit).unwrap();
        let again = report_at(&db, RangeKind::Day, Local::now()).unwrap();
        assert!(again
            .by_category
            .iter()
            .any(|c| c.category == "工作" && c.completed == 2));
        assert!(!again.by_category.iter().any(|c| c.category == "生活"));
    }

    #[test]
    fn deleting_task_cascades_completion_events() {
        let db = setup();
        let task = create_task_inner(
            &db,
            task_input("待删除", Some(local_iso(2026, 11, 4, 9, 0)), None),
        )
        .unwrap();
        toggle_task_inner(&db, &task.id).unwrap();
        assert_eq!(count_events(&db), 1);
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM tasks WHERE id = ?1",
                rusqlite::params![task.id],
            )?;
            Ok(())
        })
        .unwrap();
        assert_eq!(count_events(&db), 0);
        let report = report_at(&db, RangeKind::Day, fixed_now()).unwrap();
        assert_eq!(report.summary.completed, 0);
        assert_eq!(report.summary.due, 0);
    }

    #[test]
    fn trend_buckets_cover_windows_and_summary_equals_last_bucket() {
        let db = setup();
        let task = create_task_inner(
            &db,
            task_input("趋势", Some(local_iso(2026, 11, 4, 9, 0)), None),
        )
        .unwrap();
        toggle_task_inner(&db, &task.id).unwrap();

        for kind in [RangeKind::Day, RangeKind::Week, RangeKind::Month] {
            let report = report_at(&db, kind, fixed_now()).unwrap();
            let last = report.trend.last().unwrap();
            assert_eq!(last.completed, report.summary.completed);
            assert_eq!(last.due, report.summary.due);
            assert_eq!(last.due_overdue, report.summary.due_overdue);
        }
        assert_eq!(
            report_at(&db, RangeKind::Day, fixed_now())
                .unwrap()
                .trend
                .len(),
            14
        );
        assert_eq!(
            report_at(&db, RangeKind::Week, fixed_now())
                .unwrap()
                .trend
                .len(),
            12
        );
        assert_eq!(
            report_at(&db, RangeKind::Month, fixed_now())
                .unwrap()
                .trend
                .len(),
            12
        );
    }

    #[test]
    fn large_volume_stays_correct() {
        let db = setup();
        // 截止放到当天末尾：以注入的固定时间 10:30 判断，不算逾期。
        let due = local_iso(2026, 11, 4, 23, 0);
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            for i in 0..2000 {
                let id = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO tasks (id, title, description, priority, status, category, tags, due_at, remind_at, advance_minutes, recurrence_rule_id, created_at, updated_at, completed_at)
                     VALUES (?1, ?2, '', 2, 'pending', '压测', '[]', ?3, NULL, 0, NULL, ?4, ?4, NULL)",
                    rusqlite::params![id, format!("批量 {i}"), due, crate::agents::now_iso()],
                )?;
            }
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let report = report_at(&db, RangeKind::Day, fixed_now()).unwrap();
        assert_eq!(report.summary.due, 2000);
        assert_eq!(report.summary.completed, 0);
        assert_eq!(report.summary.overdue_rate, Some(0.0));
        assert!(report.history_complete, "普通任务的到期期次全部可还原");
    }

    // ── 历史完整性（B2）：区分实际统计与不完整统计 ─────────────────────

    fn weekly(days: Vec<u32>) -> RecurrenceRuleInput {
        RecurrenceRuleInput {
            freq: "weekly".into(),
            interval: 1,
            by_weekday: days,
            by_monthday: None,
            by_setpos: None,
        }
    }

    fn set_task_due(db: &Db, id: &str, due: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tasks SET due_at = ?1 WHERE id = ?2",
                rusqlite::params![due, id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    /// 调度器自动推进（到期触发）不写完成事件；被跨过的期次无法还原，
    /// 本期分母偏小，必须标记为不完整而不是给出虚高的完成率。
    #[test]
    fn auto_advanced_recurring_occurrence_marks_history_incomplete() {
        let db = setup();
        let due = local_iso(2026, 11, 3, 9, 0);
        let task = create_task_inner(
            &db,
            task_input("每日站会", Some(due.clone()), Some(daily())),
        )
        .unwrap();
        let now_utc = fixed_now().with_timezone(&Utc);
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let _ = crate::scheduler::advance_recurrence_tx(
                &tx,
                &task.id,
                Some(due.as_str()),
                &now_utc,
            )?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        assert_eq!(count_events(&db), 0, "自动推进不是用户完成");
        let report = report_at(&db, RangeKind::Day, fixed_now()).unwrap();
        assert_eq!(report.summary.completed, 0);
        assert_eq!(report.summary.due, 0, "被自动推进掉的今日期次没有独立记录");
        assert_eq!(
            report.summary.completion_rate, None,
            "分母为 0 不得伪装成 0%"
        );
        assert!(!report.history_complete, "存在无法还原的自动推进期次");
    }

    /// 多日未开机：一次补偿推进跨过多个每日期次，全部缺失。
    #[test]
    fn multi_day_gap_marks_history_incomplete() {
        let db = setup();
        let due = local_iso(2026, 11, 1, 9, 0);
        let task = create_task_inner(
            &db,
            task_input("每日打卡", Some(due.clone()), Some(daily())),
        )
        .unwrap();
        let now_utc = fixed_now().with_timezone(&Utc);
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let outcome = crate::scheduler::advance_recurrence_tx(
                &tx,
                &task.id,
                Some(due.as_str()),
                &now_utc,
            )?;
            tx.commit()?;
            Ok::<_, AppError>(outcome)
        })
        .unwrap();

        assert_eq!(count_events(&db), 0);
        let report = report_at(&db, RangeKind::Week, fixed_now()).unwrap();
        // 推进后的下一期（11-05）仍在周窗口内，计入分母；更早的期次不可还原。
        assert_eq!(report.summary.due, 1);
        assert_eq!(report.summary.completion_rate, Some(0.0));
        assert!(!report.history_complete, "补偿跳期后本周分母无法完整还原");
    }

    /// 提前完成（截止时间未到）是真实完成事件，分母与完成率都准确。
    #[test]
    fn early_recurring_completion_keeps_history_complete() {
        let db = setup();
        let due = today_at(23, 59);
        let task =
            create_task_inner(&db, task_input("每日复盘", Some(due), Some(daily()))).unwrap();
        toggle_task_inner(&db, &task.id).unwrap();

        let report = report_at(&db, RangeKind::Day, Local::now()).unwrap();
        assert_eq!(report.summary.completed, 1);
        assert_eq!(report.summary.due, 1);
        assert_eq!(report.summary.due_completed, 1);
        assert_eq!(report.summary.due_overdue, 0, "提前完成不算逾期");
        assert_eq!(report.summary.completion_rate, Some(1.0));
        assert!(report.history_complete);
    }

    /// 提前完成「首次发生日在窗口之后」的期次：规则行必须仍被加载，
    /// 不能因为当前 due_at 在窗口外就误判成规则已解除、凭空标记不完整。
    #[test]
    fn future_first_occurrence_completed_early_keeps_history_complete() {
        let db = setup();
        // 首次发生日在明天 09:00，落在「今日」窗口之外；今天提前完成。
        let due = day_offset(1, 9, 0);
        let task =
            create_task_inner(&db, task_input("明日周报", Some(due), Some(daily()))).unwrap();
        toggle_task_inner(&db, &task.id).unwrap();

        let report = report_at(&db, RangeKind::Day, Local::now()).unwrap();
        assert_eq!(report.summary.completed, 1);
        assert_eq!(report.summary.recurring_completed, 1);
        assert_eq!(report.summary.due, 0, "首次到期在窗口外，不计本期分母");
        assert!(
            report.history_complete,
            "提前完成未来期次不是历史缺失，不得标记不完整"
        );
    }

    /// 每个已到期期次都有完成事件或任务行时，历史可完整还原。
    #[test]
    fn fully_reconstructed_recurring_week_is_complete() {
        let db = setup();
        let monday = local_iso(2026, 11, 2, 9, 0);
        let tuesday = local_iso(2026, 11, 3, 9, 0);
        let wednesday = local_iso(2026, 11, 4, 9, 0);
        let task = create_task_inner(
            &db,
            task_input("每日站会", Some(monday.clone()), Some(daily())),
        )
        .unwrap();
        record_at_due(&db, &task.id, &local_iso(2026, 11, 2, 8, 55), &monday);
        record_at_due(&db, &task.id, &local_iso(2026, 11, 3, 8, 55), &tuesday);
        // 周三期次仍未完成（任务行就是它），应计入分母且算逾期。
        set_task_due(&db, &task.id, &wednesday);

        let report = report_at(&db, RangeKind::Week, fixed_now()).unwrap();
        assert_eq!(report.summary.due, 3);
        assert_eq!(report.summary.due_completed, 2);
        assert_eq!(report.summary.due_overdue, 1);
        assert!(report.history_complete, "周一/周二/周三期次全部可还原");
    }

    /// 每日任务本期截止已过、当时未完成，今天才补做：补偿推进同时跳过了今天的期次，
    /// 完成动作本身仍计入实际完成数，但本期到期分母不完整。
    #[test]
    fn late_completion_after_missed_period_marks_history_incomplete() {
        let db = setup();
        // 昨天 00:00 已逾期：无论测试在几点运行，补做后的下一期都落在明天，
        // 完成事件归属昨天，不会给今天凭空补出到期分母。
        let overdue = day_offset(-1, 0, 0);
        let task =
            create_task_inner(&db, task_input("补做", Some(overdue), Some(daily()))).unwrap();
        toggle_task_inner(&db, &task.id).unwrap();

        assert_eq!(count_events(&db), 1);
        let report = report_at(&db, RangeKind::Day, Local::now()).unwrap();
        assert_eq!(report.summary.completed, 1, "补做是真实完成动作");
        assert_eq!(report.summary.due, 0, "今日期次被补偿推进跨过");
        assert!(!report.history_complete);
    }

    /// 每周多日规则：未完成的周一/周三期次被自动推进跨过时标记不完整。
    #[test]
    fn weekly_auto_skip_marks_history_incomplete() {
        let db = setup();
        let monday = local_iso(2026, 11, 2, 9, 0);
        let task = create_task_inner(
            &db,
            task_input(
                "每周例会",
                Some(monday.clone()),
                Some(weekly(vec![1, 3, 5])),
            ),
        )
        .unwrap();
        let now_utc = fixed_now().with_timezone(&Utc);
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let _ = crate::scheduler::advance_recurrence_tx(
                &tx,
                &task.id,
                Some(monday.as_str()),
                &now_utc,
            )?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let report = report_at(&db, RangeKind::Week, fixed_now()).unwrap();
        assert_eq!(report.summary.completed, 0);
        // 推进后的周五期次仍在周窗口内，计入分母；周一/周三期次不可还原。
        assert_eq!(report.summary.due, 1);
        assert!(!report.history_complete, "周一/周三期次不可还原");
    }

    /// 每 N 月规则按锚点月对齐：间隔月份不应被误算为缺失期次。
    #[test]
    fn monthly_interval_aligns_without_phantom_occurrences() {
        let db = setup();
        let september = local_iso(2026, 9, 10, 9, 0);
        let october_now = Local.with_ymd_and_hms(2026, 10, 15, 10, 30, 0).unwrap();
        let task = create_task_inner(
            &db,
            task_input(
                "双月报表",
                Some(september.clone()),
                Some(RecurrenceRuleInput {
                    freq: "monthly".into(),
                    interval: 2,
                    by_weekday: vec![],
                    by_monthday: Some(10),
                    by_setpos: None,
                }),
            ),
        )
        .unwrap();
        // 10 月不是锚点月的 2 个月倍数，推进应直接到 11-10。
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let _ = crate::scheduler::advance_recurrence_tx(
                &tx,
                &task.id,
                Some(september.as_str()),
                &october_now.with_timezone(&Utc),
            )?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let report = report_at(&db, RangeKind::Month, october_now).unwrap();
        assert_eq!(report.summary.due, 0, "10 月没有该规则的期次");
        assert!(report.history_complete, "间隔月不是缺失期次");
    }

    /// 跨午夜 / 本地时区：00:10 到期、00:30 完成，属于同一天且算逾期。
    #[test]
    fn cross_midnight_due_occurrence_counts_in_local_day() {
        let db = setup();
        insert_pending_task(&db, "midnight");
        record_at_due(
            &db,
            "midnight",
            &local_iso(2026, 11, 4, 0, 30),
            &local_iso(2026, 11, 4, 0, 10),
        );

        let report = report_at(&db, RangeKind::Day, fixed_now()).unwrap();
        assert_eq!(report.summary.due, 1);
        assert_eq!(report.summary.due_completed, 1);
        assert_eq!(report.summary.due_overdue, 1);
        assert!(report.history_complete);
    }

    /// 规则被解除但重复完成事件仍在：后续期次无法再按规则还原。
    #[test]
    fn detached_rule_with_recurring_history_marks_incomplete() {
        let db = setup();
        let due = today_at(23, 59);
        let task =
            create_task_inner(&db, task_input("每日总结", Some(due), Some(daily()))).unwrap();
        toggle_task_inner(&db, &task.id).unwrap();
        // 显式清除重复规则（模拟用户「不再重复」）。
        crate::commands::tasks::update_task_inner(
            &db,
            &task.id,
            TaskInput {
                title: "每日总结".into(),
                recurrence: Some(None),
                ..Default::default()
            },
        )
        .unwrap();

        let report = report_at(&db, RangeKind::Day, Local::now()).unwrap();
        assert_eq!(report.summary.completed, 1);
        assert!(!report.history_complete, "规则已解除，重复历史不可校验");
    }
}
