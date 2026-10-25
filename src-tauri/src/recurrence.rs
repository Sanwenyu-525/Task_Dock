//! 重复任务规则与下一次发生时间计算。
//! 时间语义：next_occurrence 返回严格晚于 `after` 的下一次发生时刻（本地时区）。

use chrono::{
    DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Weekday,
};
use serde::{Deserialize, Serialize};

/// NLP 解析产出的规则草稿（落库前补 id / anchor）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RecurrenceRuleInput {
    pub freq: String, // daily | weekly | monthly
    pub interval: i64,
    pub by_weekday: Vec<u32>, // 1=周一 .. 7=周日
    pub by_monthday: Option<u32>,
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

/// 计算严格晚于 `after` 的下一次发生时刻。
/// anchor: 规则的起始日期（首次发生日）；为空时以 after 的日期为锚。
pub fn next_occurrence(
    freq: &str,
    interval: i64,
    by_weekday: &[u32],
    by_monthday: Option<u32>,
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
            let day = by_monthday.unwrap_or(after.day()).clamp(1, 31);
            let mut year = after.year();
            let mut month = after.month();
            for _ in 0..24 {
                let d = day.min(last_day_of_month(year, month));
                if let Some(date) = NaiveDate::from_ymd_opt(year, month, d) {
                    if let Some(candidate) = to_local(date.and_time(time)) {
                        if candidate > after {
                            return Some(candidate);
                        }
                    }
                }
                if month == 12 {
                    year += 1;
                    month = 1;
                } else {
                    month += 1;
                }
            }
            None
        }
        _ => None,
    }
}

/// 供测试与 UI 展示：规则的中文描述。
pub fn describe_rule(
    freq: &str,
    interval: i64,
    by_weekday: &[u32],
    by_monthday: Option<u32>,
) -> String {
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
                format!("{}（每 {} 周）", days, interval)
            }
        }
        "monthly" => {
            if interval == 1 {
                format!("每月 {} 号", by_monthday.unwrap_or(1))
            } else {
                format!("每 {} 个月 {} 号", interval, by_monthday.unwrap_or(1))
            }
        }
        _ => "不重复".into(),
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
}
