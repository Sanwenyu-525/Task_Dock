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
    date.checked_add_signed(Duration::days(days)).unwrap_or(date)
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
                Bucket { start, end: shift_days(start, 1) }
            })
            .collect(),
        RangeKind::Week => {
            let (current, _) = range_window(kind, today);
            (0..12)
                .map(|i| {
                    let start = shift_days(current, -(7 * (11 - i)));
                    Bucket { start, end: shift_days(start, 7) }
                })
                .collect()
        }
        RangeKind::Month => {
            let (current, _) = range_window(kind, today);
            (0..12)
                .map(|i| {
                    let start = shift_months(current, i - 11);
                    Bucket { start, end: shift_months(start, 1) }
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

/// 读取趋势窗口内的事件与到期任务（有界查询，不做全表扫描）。
///
/// 三条查询在同一个只读事务内执行，保证「任务行 / 完成事件 / 事件存在性」来自同一
/// 快照；否则并发完成恰好落在两条语句之间时，会出现完成数已加、到期数未加（或相反）
/// 的瞬时偏差。
fn load_rows(
    conn: &Connection,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> AppResult<(Vec<EventRow>, Vec<DueTaskRow>, HashSet<String>)> {
    let start_iso = start.to_rfc3339();
    let end_iso = end.to_rfc3339();
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

    tx.commit()?;
    Ok((events, tasks, completed_with_events))
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

    let (events, tasks, completed_with_events) =
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
    by_category.sort_by(|a, b| b.completed.cmp(&a.completed).then(a.category.cmp(&b.category)));

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
        definitions: DEFINITIONS,
    })
}

/// 指标口径（唯一来源：前端原样展示）。
pub const DEFINITIONS: AnalyticsDefinitions = AnalyticsDefinitions {
    completed: "完成数量：范围内真实发生的完成动作。普通任务每次勾选完成记 1 次；重复任务每完成一期记 1 次（任务本身保持未完成并推进到下一期）；同一任务的同一期次只计 1 次。",
    completion_rate: "完成率 = 本期到期任务中已完成的数量 / 本期到期任务数。分母含本期尚未到期的任务，因此本期未结束时它是「当前进度」而不是最终结果。",
    overdue_rate: "逾期率 = 本期到期任务中逾期的数量 / 本期到期任务数。逾期指：完成时间晚于截止时间，或仍未完成且截止时间已过（本期尚未到期的任务不算逾期）。",
    trend: "趋势按本地日历分桶：日视图近 14 天、周视图近 12 周（周一为一周起点）、月视图近 12 个月。完成与逾期同为计数，共用刻度。",
    distribution: "分类 / 优先级分布按「完成事件发生时的快照」统计；分类为空显示为「未分类」。这是完成分布，不代表各分类的整体效率。",
    history: "历史限制：升级前已完成的普通任务按数据库中真实的 completed_at 回填；重复任务的历史完成期次在升级前没有持久化，无法还原，也不会伪造回填。升级后的完成动作会写入完成事件并按期次去重。",
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

    fn task_input(title: &str, due: Option<String>, recurrence: Option<RecurrenceRuleInput>) -> TaskInput {
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
        db.with_read(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM task_completion_events", [], |r| r.get(0))?))
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
        db.with_conn(|conn| record_completion(conn, id, completed_at, None, "", 2, "once")).unwrap();
    }

    fn record_at_due(db: &Db, id: &str, completed_at: &str, due_at: &str) {
        db.with_conn(|conn| {
            record_completion(conn, id, completed_at, Some(due_at), "", 2, "once")
        })
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
    }

    #[test]
    fn completing_task_records_event_and_full_rate() {
        let db = setup();
        // 截止时间放到当天末尾，避免真实时钟决定「是否晚于截止」而影响完成率断言。
        let today_due = local_iso(2026, 11, 4, 23, 59);
        let task = create_task_inner(&db, task_input("写报告", Some(today_due), None)).unwrap();
        toggle_task_inner(&db, &task.id).unwrap();

        assert_eq!(count_events(&db), 1);
        let report = report_at(&db, RangeKind::Day, fixed_now()).unwrap();
        assert_eq!(report.summary.completed, 1);
        assert_eq!(report.summary.recurring_completed, 0);
        assert_eq!(report.summary.due, 1);
        assert_eq!(report.summary.due_completed, 1);
        assert_eq!(report.summary.completion_rate, Some(1.0));
    }

    #[test]
    fn reopening_removes_completion_event() {
        let db = setup();
        let task = create_task_inner(&db, task_input("可撤销", Some(local_iso(2026, 11, 4, 9, 0)), None)).unwrap();
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
        assert_eq!(count_events(&db), 1, "同一 (task_id, due_at) 只能有一条用户事件");
    }

    #[test]
    fn reopening_removes_backfilled_completion_event() {
        let db = setup();
        let due = local_iso(2026, 11, 3, 9, 0);
        let completed_at = local_iso(2026, 11, 3, 10, 0);
        let task = create_task_inner(&db, task_input("升级前完成", Some(due.clone()), None)).unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tasks SET status = 'completed', completed_at = ?1 WHERE id = ?2",
                rusqlite::params![completed_at, task.id],
            )?;
            conn.execute(
                "INSERT INTO task_completion_events
                   (id, task_id, completed_at, due_at, category, priority, origin, kind, created_at)
                 VALUES (?1, ?2, ?3, ?4, '', 2, 'backfill', 'once', ?3)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    task.id,
                    completed_at,
                    due
                ],
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
            task_input("每日站会", Some(yesterday.with_timezone(&Utc).to_rfc3339()), Some(daily())),
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
        let task = create_task_inner(&db, task_input("每日复盘", Some(due.clone()), Some(daily()))).unwrap();

        toggle_task_inner(&db, &task.id).unwrap();

        let after = crate::commands::tasks::get_task(&db, &task.id).unwrap();
        assert_eq!(after.status, "pending");
        assert_ne!(after.due_at.as_deref(), Some(due.as_str()), "应推进到下一期");
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
        assert_eq!(rows[0].1.as_deref(), Some(due.as_str()), "事件归属被消耗的期次");
        assert_eq!(rows[0].2, "recurring");
    }

    /// v0.10 原子性 #2（失败注入）：事件插入失败时，期次推进与提醒重建必须整体回滚。
    #[test]
    fn completion_event_failure_rolls_back_advance_and_reminders() {
        let db = setup();
        let due = local_iso(2026, 11, 4, 23, 59);
        let task = create_task_inner(&db, task_input("每日站会", Some(due.clone()), Some(daily()))).unwrap();
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
        assert!(format!("{err}").contains("injected"), "应返回真实失败原因: {err}");

        let after = crate::commands::tasks::get_task(&db, &task.id).unwrap();
        assert_eq!(after.due_at.as_deref(), Some(due.as_str()), "任务期次必须回滚");
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
        let task = create_task_inner(&db, task_input("每日站会", Some(due.clone()), Some(daily()))).unwrap();

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
        assert_eq!(after.due_at.as_deref(), Some(expected_to.as_str()), "期次保持不变");
    }

    /// v0.10 原子性 #5：自动到期推进（调度器路径）不是用户完成，不得写完成事件。
    #[test]
    fn auto_advance_does_not_create_user_events() {
        use crate::scheduler::advance_recurrence_tx;
        let db = setup();
        let due = local_iso(2026, 11, 4, 23, 59);
        let task = create_task_inner(&db, task_input("每日站会", Some(due.clone()), Some(daily()))).unwrap();

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
        create_task_inner(&db, task_input("逾期未做", Some(local_iso(2026, 11, 3, 9, 0)), None)).unwrap();
        create_task_inner(&db, task_input("今晚到期", Some(local_iso(2026, 11, 4, 23, 0)), None)).unwrap();

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
        let a = task_input("A", Some(local_iso(2026, 11, 4, 9, 0)), None);
        let mut a = a;
        a.category = Some("工作".into());
        a.priority = Some(0);
        let task_a = create_task_inner(&db, a).unwrap();
        let mut b = task_input("B", Some(local_iso(2026, 11, 4, 9, 30)), None);
        b.category = Some("工作".into());
        b.priority = Some(0);
        let task_b = create_task_inner(&db, b).unwrap();
        let task_c = create_task_inner(&db, task_input("C", Some(local_iso(2026, 11, 4, 10, 0)), None)).unwrap();

        toggle_task_inner(&db, &task_a.id).unwrap();
        toggle_task_inner(&db, &task_b.id).unwrap();
        toggle_task_inner(&db, &task_c.id).unwrap();

        let report = report_at(&db, RangeKind::Day, fixed_now()).unwrap();
        let work = report.by_category.iter().find(|c| c.category == "工作").unwrap();
        assert_eq!(work.completed, 2);
        assert!((work.share - 2.0 / 3.0).abs() < 1e-9);
        assert!(report.by_category.iter().any(|c| c.category == "未分类" && c.completed == 1));
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
        let again = report_at(&db, RangeKind::Day, fixed_now()).unwrap();
        assert!(again.by_category.iter().any(|c| c.category == "工作" && c.completed == 2));
        assert!(!again.by_category.iter().any(|c| c.category == "生活"));
    }

    #[test]
    fn deleting_task_cascades_completion_events() {
        let db = setup();
        let task = create_task_inner(&db, task_input("待删除", Some(local_iso(2026, 11, 4, 9, 0)), None)).unwrap();
        toggle_task_inner(&db, &task.id).unwrap();
        assert_eq!(count_events(&db), 1);
        db.with_conn(|conn| {
            conn.execute("DELETE FROM tasks WHERE id = ?1", rusqlite::params![task.id])?;
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
        let task = create_task_inner(&db, task_input("趋势", Some(local_iso(2026, 11, 4, 9, 0)), None)).unwrap();
        toggle_task_inner(&db, &task.id).unwrap();

        for kind in [RangeKind::Day, RangeKind::Week, RangeKind::Month] {
            let report = report_at(&db, kind, fixed_now()).unwrap();
            let last = report.trend.last().unwrap();
            assert_eq!(last.completed, report.summary.completed);
            assert_eq!(last.due, report.summary.due);
            assert_eq!(last.due_overdue, report.summary.due_overdue);
        }
        assert_eq!(report_at(&db, RangeKind::Day, fixed_now()).unwrap().trend.len(), 14);
        assert_eq!(report_at(&db, RangeKind::Week, fixed_now()).unwrap().trend.len(), 12);
        assert_eq!(report_at(&db, RangeKind::Month, fixed_now()).unwrap().trend.len(), 12);
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
    }
}
