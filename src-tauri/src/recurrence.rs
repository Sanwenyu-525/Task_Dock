//! 重复任务规则与下一次发生时间计算。
//! 时间语义：next_occurrence 返回严格晚于 `after` 的下一次发生时刻（本地时区）。
//!
//! 规则形态（2026-11 智能日程提醒 2.0 扩展）：
//! - 每天 / 每 N 天：`freq=daily`；
//! - 每周指定星期 / 每 N 周（含「工作日」= 每周一至周五）：`freq=weekly` + `by_weekday`；
//! - 每月指定日 / 每 N 月指定日：`freq=monthly` + `by_monthday`；
//! - 每月第 N 个星期X / 每月最后一个星期X / 每月最后一个工作日：
//!   `freq=monthly` + `by_weekday` + `by_setpos`（1..=5 第 N 个，-1 最后一个；
//!   「最后一个工作日」即 by_weekday=[1..5] + by_setpos=-1，不接节假日 API）。
//!
//! 工作日为自然周语义（周一至周五），不支持法定节假日/调休跳过，UI 不得宣称支持。

use chrono::{
    DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Weekday,
};
use serde::{Deserialize, Serialize};

/// NLP 解析产出的规则草稿（落库前补 id / anchor）。
///
/// `by_setpos` 为 2026-11 新增字段：serde `default` 保证旧载荷（无该键）与
/// 旧库数据可读、旧行为不变；新字段非法组合由 [`validate_rule`] 严格拒绝。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RecurrenceRuleInput {
    pub freq: String, // daily | weekly | monthly
    #[serde(default)]
    pub interval: i64,
    #[serde(default)]
    pub by_weekday: Vec<u32>, // 1=周一 .. 7=周日
    #[serde(default)]
    pub by_monthday: Option<u32>,
    /// 每月第 N 个星期X（1..=5）或最后一个（-1）；仅 monthly + by_weekday 有效。
    #[serde(default)]
    pub by_setpos: Option<i32>,
}

pub const WEEKDAY_CN: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

pub fn weekday_num(d: NaiveDate) -> u32 {
    match d.weekday() {
        Weekday::Mon => 1,
        Weekday::Tue => 2,
        Weekday::Wed => 3,
        Weekday::Thu => 4,
        Weekday::Fri => 5,
        Weekday::Sat => 6,
        Weekday::Sun => 7,
    }
}

/// NaiveDateTime → 本地 DateTime（模糊/不存在时取最早值）。
fn to_local(dt: NaiveDateTime) -> Option<DateTime<Local>> {
    Local
        .from_local_datetime(&dt)
        .single()
        .or_else(|| Local.from_local_datetime(&dt).earliest())
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    let (y, m) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(y, m, 1)
        .unwrap()
        .pred_opt()
        .unwrap()
        .day()
}

/// 校验规则输入的合法组合，返回中文错误原因（空串 = 合法）。
///
/// 兼容性边界：
/// - 旧数据（无 by_setpos）恒可通过，行为与扩展前一致；
/// - `by_setpos` 只在 `freq=monthly` 且 `by_weekday` 非空时有意义，
///   与 `by_monthday` 互斥（同时出现属非法组合，严格拒绝而非静默取舍）；
/// - 星期值必须在 1..=7；间隔至少 1。
pub fn validate_rule(r: &RecurrenceRuleInput) -> Result<(), String> {
    match r.freq.as_str() {
        "" => return Ok(()), // 空规则 = 不重复（前端空表单语义）
        "daily" | "weekly" | "monthly" => {}
        other => return Err(format!("不支持的重复频率: {}", other)),
    }
    if r.interval < 1 {
        return Err("重复间隔必须 ≥ 1".into());
    }
    if r.by_weekday.iter().any(|d| !(1..=7).contains(d)) {
        return Err("星期值必须在 1（周一）至 7（周日）之间".into());
    }
    if let Some(d) = r.by_monthday {
        if !(1..=31).contains(&d) {
            return Err("每月几日必须在 1 至 31 之间".into());
        }
    }
    if let Some(pos) = r.by_setpos {
        if r.freq != "monthly" {
            return Err("「每月第 N 个星期X」仅支持按月重复".into());
        }
        if r.by_weekday.is_empty() {
            return Err("「每月第 N 个星期X」需要指定星期".into());
        }
        if r.by_monthday.is_some() {
            return Err("「每月几日」与「每月第 N 个星期X」不能同时设置".into());
        }
        if pos != -1 && !(1..=5).contains(&pos) {
            return Err("「第 N 个星期X」的 N 必须在 1 至 5 之间，或选择「最后一个」".into());
        }
    }
    Ok(())
}

/// 计算某月中第 N 个（或最后一个，-1）命中 `by_weekday` 的日期。
/// 该月不存在第 N 个命中日（如第 5 个周一）时返回 None（跳过该月）。
fn nth_weekday_in_month(year: i32, month: u32, by_weekday: &[u32], pos: i32) -> Option<NaiveDate> {
    let last = last_day_of_month(year, month);
    let mut hits: Vec<NaiveDate> = Vec::new();
    for day in 1..=last {
        let date = NaiveDate::from_ymd_opt(year, month, day)?;
        if by_weekday.contains(&weekday_num(date)) {
            hits.push(date);
        }
    }
    if pos == -1 {
        hits.last().copied()
    } else {
        hits.get(pos as usize - 1).copied()
    }
}

/// 计算严格晚于 `after` 的下一次发生时刻。
/// anchor: 规则的起始日期（首次发生日）；为空时以 after 的日期为锚。
///
/// 兼容入口：不带 `by_setpos`（等价 None），供旧调用方与回归测试使用。
pub fn next_occurrence(
    freq: &str,
    interval: i64,
    by_weekday: &[u32],
    by_monthday: Option<u32>,
    anchor: Option<NaiveDate>,
    after: DateTime<Local>,
) -> Option<DateTime<Local>> {
    next_occurrence_ex(freq, interval, by_weekday, by_monthday, None, anchor, after)
}

/// 完整规则形态的下次发生计算（含每月第 N 个星期X / 最后一个星期X）。
///
/// monthly.interval 修复（2026-11）：旧实现逐月 +1 枚举、从不校验与锚点的
/// 月差，「每两个月 10 日」会退化成每月 10 日触发。现改为从锚点月起按
/// `interval` 步进枚举候选月，月差非 interval 倍数的月份直接跳过；
/// 锚点缺失时以 after 所在月为相位原点（与旧 interval=1 行为一致）。
pub fn next_occurrence_ex(
    freq: &str,
    interval: i64,
    by_weekday: &[u32],
    by_monthday: Option<u32>,
    by_setpos: Option<i32>,
    anchor: Option<NaiveDate>,
    after: DateTime<Local>,
) -> Option<DateTime<Local>> {
    let interval = interval.max(1);
    let time: NaiveTime = after.time();
    let anchor = anchor.unwrap_or_else(|| after.date_naive());
    let horizon = 800; // 最大搜索天数，兜底防死循环
    match freq {
        "daily" => {
            let date = after.date_naive() + Duration::days(interval);
            to_local(date.and_time(time))
        }
        "weekly" => {
            if by_weekday.is_empty() {
                return None;
            }
            let mut date = after.date_naive() + Duration::days(1);
            for _ in 0..horizon {
                let wd = weekday_num(date);
                if by_weekday.contains(&wd) {
                    let weeks = (date - anchor).num_weeks();
                    if weeks % interval == 0 {
                        return to_local(date.and_time(time));
                    }
                }
                date += Duration::days(1);
            }
            None
        }
        "monthly" => {
            // 锚点月（相位原点）：锚点日期所在月；候选月 = 锚点月 + k*interval。
            let anchor_total = anchor.year() as i64 * 12 + (anchor.month() as i64 - 1);
            // 上限足够覆盖 100 年（interval ≤ 12 时），防 until 异常导致死循环。
            for k in 0..=1200i64 {
                let total = anchor_total + k * interval;
                let year = total.div_euclid(12) as i32;
                let month = (total.rem_euclid(12) + 1) as u32;
                let date = if let Some(pos) = by_setpos.filter(|_| !by_weekday.is_empty()) {
                    // 每月第 N 个星期X / 最后一个星期X（该月无命中则跳过）
                    nth_weekday_in_month(year, month, by_weekday, pos)
                } else {
                    let day = by_monthday.unwrap_or(after.day()).clamp(1, 31);
                    let d = day.min(last_day_of_month(year, month));
                    NaiveDate::from_ymd_opt(year, month, d)
                };
                let Some(date) = date else { continue };
                if let Some(candidate) = to_local(date.and_time(time)) {
                    if candidate > after {
                        return Some(candidate);
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// 供测试与 UI 展示：规则的中文描述（不带 by_setpos 的兼容入口）。
pub fn describe_rule(
    freq: &str,
    interval: i64,
    by_weekday: &[u32],
    by_monthday: Option<u32>,
) -> String {
    describe_rule_ex(freq, interval, by_weekday, by_monthday, None)
}

/// 完整规则形态的中文描述（含第 N 个星期X / 最后一个）。
pub fn describe_rule_ex(
    freq: &str,
    interval: i64,
    by_weekday: &[u32],
    by_monthday: Option<u32>,
    by_setpos: Option<i32>,
) -> String {
    let every_n = |unit: &str| {
        if interval == 1 {
            String::new()
        } else {
            format!("每 {} {} ", interval, unit)
        }
    };
    match freq {
        "daily" => {
            if interval == 1 {
                "每天".into()
            } else {
                format!("每 {} 天", interval)
            }
        }
        "weekly" => {
            let days = if by_weekday.is_empty() {
                "每周".to_string()
            } else {
                by_weekday
                    .iter()
                    .filter_map(|d| WEEKDAY_CN.get((*d as usize).saturating_sub(1)).copied())
                    .collect::<Vec<_>>()
                    .join("、")
            };
            if interval == 1 {
                days
            } else {
                // 旧格式保持不变（v0.x 起 UI 已按此展示，不做无谓改写）
                format!("{}（每 {} 周）", days, interval)
            }
        }
        "monthly" => {
            let prefix = if interval == 1 {
                "每月".to_string()
            } else {
                format!("每 {} 个月", interval)
            };
            if let Some(pos) = by_setpos.filter(|_| !by_weekday.is_empty()) {
                let days = by_weekday
                    .iter()
                    .filter_map(|d| WEEKDAY_CN.get((*d as usize).saturating_sub(1)).copied())
                    .collect::<Vec<_>>()
                    .join("、");
                if pos == -1 {
                    format!("{}最后一个{}", prefix, days)
                } else {
                    const ORD: [&str; 5] = ["一", "二", "三", "四", "五"];
                    let ord = ORD
                        .get(pos.unsigned_abs() as usize - 1)
                        .copied()
                        .unwrap_or("?");
                    format!("{}第{}个{}", prefix, ord, days)
                }
            } else if let Some(day) = by_monthday {
                format!("{} {} 号", prefix, day)
            } else {
                format!("{}（未指定日）", prefix)
            }
        }
        _ => {
            let _ = every_n;
            "不重复".into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> DateTime<Local> {
        DateTime::parse_from_rfc3339(s)
            .unwrap()
            .with_timezone(&Local)
    }

    fn base() -> DateTime<Local> {
        // 2026-10-25 是周日
        dt("2026-10-25T10:00:00+08:00")
    }

    #[test]
    fn daily_next_is_tomorrow_same_time() {
        let next = next_occurrence("daily", 1, &[], None, None, base()).unwrap();
        assert_eq!(next, dt("2026-10-26T10:00:00+08:00"));
    }

    #[test]
    fn daily_interval_3() {
        let next = next_occurrence("daily", 3, &[], None, None, base()).unwrap();
        assert_eq!(next, dt("2026-10-28T10:00:00+08:00"));
    }

    #[test]
    fn weekly_picks_next_weekday() {
        // 每周一：周日之后的下一个周一
        let next = next_occurrence("weekly", 1, &[1], None, None, base()).unwrap();
        assert_eq!(next, dt("2026-10-26T10:00:00+08:00"));
    }

    #[test]
    fn weekly_multiple_days() {
        // 每周一、三、五
        let next = next_occurrence("weekly", 1, &[1, 3, 5], None, None, base()).unwrap();
        assert_eq!(next, dt("2026-10-26T10:00:00+08:00"));
    }

    #[test]
    fn weekly_biweekly_respects_anchor() {
        // 每两周周一，锚点为 2026-10-19（周一）
        let anchor = NaiveDate::from_ymd_opt(2026, 10, 19).unwrap();
        let next = next_occurrence("weekly", 2, &[1], None, Some(anchor), base()).unwrap();
        // 10-26 是锚点后 1 周，跳过；下一个是 11-02
        assert_eq!(next, dt("2026-11-02T10:00:00+08:00"));
    }

    #[test]
    fn monthly_clamps_day() {
        // 每月 31 号，从 10-25 之后 → 10-31
        let next = next_occurrence("monthly", 1, &[], Some(31), None, base()).unwrap();
        assert_eq!(next, dt("2026-10-31T10:00:00+08:00"));
    }

    #[test]
    fn monthly_clamps_to_february() {
        let after = dt("2026-01-31T09:00:00+08:00");
        let next = next_occurrence("monthly", 1, &[], Some(31), None, after).unwrap();
        // 2 月无 31 日 → 2 月 28 日（2026 非闰年）
        assert_eq!(next, dt("2026-02-28T09:00:00+08:00"));
    }

    #[test]
    fn unknown_freq_returns_none() {
        assert!(next_occurrence("yearly", 1, &[], None, None, base()).is_none());
    }

    #[test]
    fn describe() {
        assert_eq!(describe_rule("daily", 1, &[], None), "每天");
        assert_eq!(describe_rule("weekly", 1, &[1, 5], None), "周一、周五");
        assert_eq!(describe_rule("monthly", 1, &[], Some(3)), "每月 3 号");
    }

    // ── monthly.interval 缺陷复现与修复（智能日程提醒 2.0）──────────

    /// 复现：每两个月 10 日（锚点 2026-08-10）从 2026-10-25 之后推进，
    /// 旧实现逐月 +1 会返回 2026-11-10（每月触发）；修复后必须跳过
    /// 非偶数月差的月份，返回 2026-12-10。
    #[test]
    fn monthly_interval_2_skips_odd_months() {
        let anchor = NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        let next = next_occurrence("monthly", 2, &[], Some(10), Some(anchor), base()).unwrap();
        assert_eq!(
            next,
            dt("2026-12-10T10:00:00+08:00"),
            "每两个月的下一次必须是锚点月起隔两个月，不得退化为每月触发"
        );
    }

    /// 连续推进两次验证相位稳定：10-10 → 12-10 → 次年 2-10。
    #[test]
    fn monthly_interval_2_chain_stays_aligned() {
        let anchor = NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        let first = next_occurrence("monthly", 2, &[], Some(10), Some(anchor), base()).unwrap();
        assert_eq!(first, dt("2026-12-10T10:00:00+08:00"));
        let second = next_occurrence("monthly", 2, &[], Some(10), Some(anchor), first).unwrap();
        assert_eq!(second, dt("2027-02-10T10:00:00+08:00"));
    }

    /// 锚点月本身已过（after 在锚点月内且日已过）→ 下一个候选月。
    #[test]
    fn monthly_interval_2_from_anchor_month() {
        let anchor = NaiveDate::from_ymd_opt(2026, 10, 10).unwrap();
        let after = dt("2026-10-15T09:00:00+08:00");
        let next = next_occurrence("monthly", 2, &[], Some(10), Some(anchor), after).unwrap();
        assert_eq!(next, dt("2026-12-10T09:00:00+08:00"));
    }

    /// interval=1 保持旧行为：逐月推进。
    #[test]
    fn monthly_interval_1_unchanged() {
        let anchor = NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        let next = next_occurrence("monthly", 1, &[], Some(10), Some(anchor), base()).unwrap();
        assert_eq!(next, dt("2026-11-10T10:00:00+08:00"));
    }

    // ── 新规则：每月第 N 个星期X / 最后一个星期X / 最后一个工作日 ──

    /// 每月第二个星期一：2026-11 的第二个周一是 11-09。
    #[test]
    fn monthly_nth_weekday_second_monday() {
        let next = next_occurrence_ex("monthly", 1, &[1], None, Some(2), None, base()).unwrap();
        assert_eq!(next, dt("2026-11-09T10:00:00+08:00"));
    }

    /// 每月最后一个星期五：2026-10 的最后一个周五是 10-30。
    #[test]
    fn monthly_last_weekday_last_friday() {
        let next = next_occurrence_ex("monthly", 1, &[5], None, Some(-1), None, base()).unwrap();
        assert_eq!(next, dt("2026-10-30T10:00:00+08:00"));
    }

    /// 每月最后一个工作日（周一至周五）：2026-10-31 是周六 → 10-30 周五。
    #[test]
    fn monthly_last_workday() {
        let next = next_occurrence_ex("monthly", 1, &[1, 2, 3, 4, 5], None, Some(-1), None, base())
            .unwrap();
        assert_eq!(next, dt("2026-10-30T10:00:00+08:00"));
    }

    /// 11 月最后一个工作日：2026-11-30 是周一 → 当天。
    #[test]
    fn monthly_last_workday_when_month_ends_on_weekday() {
        let after = dt("2026-11-01T10:00:00+08:00");
        let next = next_occurrence_ex("monthly", 1, &[1, 2, 3, 4, 5], None, Some(-1), None, after)
            .unwrap();
        assert_eq!(next, dt("2026-11-30T10:00:00+08:00"));
    }

    /// 第 5 个星期一在部分月份不存在 → 跳过该月，取下一月第 5 个周一。
    #[test]
    fn monthly_5th_weekday_skips_month_without_hit() {
        // 2026-11 有 5 个周一（…/23/30）→ 命中 11-30；
        // 2026-12 与 2027-01、02 都只有 4 个周一 → 跳到 2027-03 的第 5 个周一 03-29。
        let after = dt("2026-11-01T10:00:00+08:00");
        let next = next_occurrence_ex("monthly", 1, &[1], None, Some(5), None, after).unwrap();
        assert_eq!(next, dt("2026-11-30T10:00:00+08:00"));
        let next2 = next_occurrence_ex("monthly", 1, &[1], None, Some(5), None, next).unwrap();
        assert_eq!(next2, dt("2027-03-29T10:00:00+08:00"));
    }

    /// 每两个月的第二个星期一（interval 与 setpos 叠加）。
    #[test]
    fn monthly_interval_2_nth_weekday() {
        let anchor = NaiveDate::from_ymd_opt(2026, 10, 12).unwrap(); // 10 月第二个周一
        let next =
            next_occurrence_ex("monthly", 2, &[1], None, Some(2), Some(anchor), base()).unwrap();
        // 锚点 10 月 → 候选 12 月；2026-12 第二个周一 = 12-14
        assert_eq!(next, dt("2026-12-14T10:00:00+08:00"));
    }

    /// 跨年：2026-12 → 2027-01（含月末日与 setpos 的年边界）。
    #[test]
    fn monthly_setpos_crosses_year() {
        let after = dt("2026-12-20T10:00:00+08:00");
        let next = next_occurrence_ex("monthly", 1, &[3], None, Some(1), None, after).unwrap();
        // 2027-01 第一个周三 = 01-06
        assert_eq!(next, dt("2027-01-06T10:00:00+08:00"));
    }

    /// 闰年 2 月末：2028-02 最后一天 29（周二），最后一个工作日 = 02-29。
    #[test]
    fn monthly_last_workday_leap_february() {
        let after = dt("2028-02-01T10:00:00+08:00");
        let next = next_occurrence_ex("monthly", 1, &[1, 2, 3, 4, 5], None, Some(-1), None, after)
            .unwrap();
        assert_eq!(next, dt("2028-02-29T10:00:00+08:00"));
    }

    /// 工作日规则 = weekly by_weekday[1..5]，每 N 周语义照常受锚点约束。
    #[test]
    fn workday_rule_is_weekly_monday_to_friday() {
        // 周日 10-25 之后 → 周一 10-26
        let next = next_occurrence("weekly", 1, &[1, 2, 3, 4, 5], None, None, base()).unwrap();
        assert_eq!(next, dt("2026-10-26T10:00:00+08:00"));
        // 周一 10-26 之后 → 周二 10-27；周五 10-30 之后 → 下周一 11-02（跳过周末）
        let next2 = next_occurrence("weekly", 1, &[1, 2, 3, 4, 5], None, None, next).unwrap();
        assert_eq!(next2, dt("2026-10-27T10:00:00+08:00"));
        let friday = dt("2026-10-30T10:00:00+08:00");
        let next3 = next_occurrence("weekly", 1, &[1, 2, 3, 4, 5], None, None, friday).unwrap();
        assert_eq!(next3, dt("2026-11-02T10:00:00+08:00"));
    }

    #[test]
    fn describe_new_rules() {
        assert_eq!(
            describe_rule_ex("monthly", 1, &[1], None, Some(2)),
            "每月第二个周一"
        );
        assert_eq!(
            describe_rule_ex("monthly", 1, &[5], None, Some(-1)),
            "每月最后一个周五"
        );
        assert_eq!(
            describe_rule_ex("monthly", 1, &[1, 2, 3, 4, 5], None, Some(-1)),
            "每月最后一个周一、周二、周三、周四、周五"
        );
        assert_eq!(
            describe_rule_ex("monthly", 2, &[1], None, Some(2)),
            "每 2 个月第二个周一"
        );
        assert_eq!(
            describe_rule_ex("weekly", 2, &[1, 3], None, None),
            "周一、周三（每 2 周）"
        );
        assert_eq!(
            describe_rule_ex("monthly", 1, &[], Some(5), None),
            "每月 5 号"
        );
        assert_eq!(
            describe_rule_ex("monthly", 2, &[], Some(10), None),
            "每 2 个月 10 号"
        );
    }

    // ── 校验 ─────────────────────────────────────────────────────

    #[test]
    fn validate_accepts_legacy_and_new_rules() {
        // 旧数据形态（by_setpos 缺省 None）
        assert!(validate_rule(&RecurrenceRuleInput {
            freq: "monthly".into(),
            interval: 2,
            by_weekday: vec![],
            by_monthday: Some(10),
            by_setpos: None,
        })
        .is_ok());
        assert!(validate_rule(&RecurrenceRuleInput {
            freq: "weekly".into(),
            interval: 1,
            by_weekday: vec![1, 2, 3, 4, 5],
            by_monthday: None,
            by_setpos: None,
        })
        .is_ok());
        // 新形态
        assert!(validate_rule(&RecurrenceRuleInput {
            freq: "monthly".into(),
            interval: 1,
            by_weekday: vec![1],
            by_monthday: None,
            by_setpos: Some(2),
        })
        .is_ok());
        assert!(validate_rule(&RecurrenceRuleInput {
            freq: "monthly".into(),
            interval: 1,
            by_weekday: vec![1, 2, 3, 4, 5],
            by_monthday: None,
            by_setpos: Some(-1),
        })
        .is_ok());
    }

    #[test]
    fn validate_rejects_illegal_combinations() {
        // by_setpos 只允许 monthly
        assert!(validate_rule(&RecurrenceRuleInput {
            freq: "weekly".into(),
            interval: 1,
            by_weekday: vec![1],
            by_monthday: None,
            by_setpos: Some(1),
        })
        .is_err());
        // by_setpos 需要 by_weekday
        assert!(validate_rule(&RecurrenceRuleInput {
            freq: "monthly".into(),
            interval: 1,
            by_weekday: vec![],
            by_monthday: None,
            by_setpos: Some(1),
        })
        .is_err());
        // by_setpos 与 by_monthday 互斥
        assert!(validate_rule(&RecurrenceRuleInput {
            freq: "monthly".into(),
            interval: 1,
            by_weekday: vec![1],
            by_monthday: Some(3),
            by_setpos: Some(1),
        })
        .is_err());
        // N 越界
        assert!(validate_rule(&RecurrenceRuleInput {
            freq: "monthly".into(),
            interval: 1,
            by_weekday: vec![1],
            by_monthday: None,
            by_setpos: Some(6),
        })
        .is_err());
        assert!(validate_rule(&RecurrenceRuleInput {
            freq: "monthly".into(),
            interval: 1,
            by_weekday: vec![1],
            by_monthday: None,
            by_setpos: Some(-2),
        })
        .is_err());
        // 星期越界 / 未知频率
        assert!(validate_rule(&RecurrenceRuleInput {
            freq: "weekly".into(),
            interval: 1,
            by_weekday: vec![8],
            by_monthday: None,
            by_setpos: None,
        })
        .is_err());
        assert!(validate_rule(&RecurrenceRuleInput {
            freq: "yearly".into(),
            interval: 1,
            by_weekday: vec![],
            by_monthday: None,
            by_setpos: None,
        })
        .is_err());
    }
}
