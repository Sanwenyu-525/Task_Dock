//! 中文自然语言快速录入解析。
//!
//! 设计原则（对应需求「不能正确解析时，保留原始内容，让用户手动确认时间；不要静默猜测」）：
//! - 只做「明确的日期/时刻/重复/提前」识别，未识别时 due_at = None，由前端提示用户手动确认；
//! - 识别到日期但无时刻时，默认补 09:00 并标记 date_only，前端需明示该默认值；
//! - 解析过程可解释：matched 记录所有被消费的原文片段。

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone};
use regex::{Captures, Regex};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};

use crate::recurrence::{next_occurrence, weekday_num, RecurrenceRuleInput};

#[derive(Debug, Clone, Serialize)]
pub struct ParsedInput {
    /// 去掉时间表达后的标题（为空则回退原文）
    pub title: String,
    pub due_at: Option<DateTime<Local>>,
    pub recurrence: Option<RecurrenceRuleInput>,
    pub advance_minutes: Option<i64>,
    /// 被消费掉的原文片段（用于前端「已识别」提示）
    pub matched: Vec<String>,
    /// 是否识别到明确时刻（含「下午」这类时段默认时刻）
    pub has_explicit_time: bool,
    /// 仅识别到日期、未识别到时刻（已补默认 09:00）
    pub date_only: bool,
}

fn compiled(pattern: &str) -> &'static Regex {
    static CACHE: OnceLock<Mutex<Vec<(String, &'static Regex)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    let mut guard = cache.lock().unwrap();
    if let Some((_, r)) = guard.iter().find(|(p, _)| p == pattern) {
        return r;
    }
    let r: &'static Regex = Box::leak(Box::new(Regex::new(pattern).unwrap()));
    guard.push((pattern.to_string(), r));
    r
}

/// 若 pattern 匹配：把原文片段记入 matched、从 s 中移除，返回各捕获组（owned）。
fn take(pattern: &str, s: &mut String, matched: &mut Vec<String>) -> Option<Vec<Option<String>>> {
    let rx = compiled(pattern);
    let (whole, groups) = {
        let caps: Captures<'_> = rx.captures(s.as_str())?;
        let m = caps.get(0).unwrap();
        let groups = (1..caps.len())
            .map(|i| caps.get(i).map(|g| g.as_str().to_string()))
            .collect::<Vec<_>>();
        (m.as_str().to_string(), groups)
    };
    matched.push(whole.clone());
    if let Some(pos) = s.find(&whole) {
        s.replace_range(pos..pos + whole.len(), " ");
    }
    Some(groups)
}

/// 中文数字 → 整数（支持 0-9999）。
fn cn_num(s: &str) -> Option<i64> {
    if let Ok(n) = s.parse::<i64>() {
        return Some(n);
    }
    let mut section = 0i64;
    let mut number = 0i64;
    let mut seen = false;
    for c in s.chars() {
        let (digit, unit) = match c {
            '零' => (0, 1),
            '一' | '壹' => (1, 1),
            '二' | '两' | '贰' => (2, 1),
            '三' | '叁' => (3, 1),
            '四' | '肆' => (4, 1),
            '五' | '伍' => (5, 1),
            '六' | '陆' => (6, 1),
            '七' | '柒' => (7, 1),
            '八' | '捌' => (8, 1),
            '九' | '玖' => (9, 1),
            '十' => (0, 10),
            '百' => (0, 100),
            _ => return None,
        };
        seen = true;
        if unit == 1 {
            number = digit;
        } else {
            let base = if number == 0 { 1 } else { number };
            section += base * unit;
            number = 0;
        }
    }
    if !seen {
        return None;
    }
    Some(section + number)
}

fn weekday_char(c: char) -> Option<u32> {
    match c {
        '一' => Some(1),
        '二' => Some(2),
        '三' => Some(3),
        '四' => Some(4),
        '五' => Some(5),
        '六' => Some(6),
        '日' | '天' | '七' => Some(7),
        '1'..='7' => c.to_digit(10),
        _ => None,
    }
}

fn period_default_hour(period: &str) -> Option<u32> {
    match period {
        "凌晨" => Some(5),
        "早上" | "早晨" | "清晨" => Some(8),
        "上午" => Some(9),
        "中午" => Some(12),
        "下午" => Some(14),
        "傍晚" => Some(18),
        "晚上" => Some(20),
        "夜里" | "深夜" => Some(22),
        _ => None,
    }
}

fn is_evening_period(period: &str) -> bool {
    matches!(period, "下午" | "傍晚" | "晚上" | "夜里" | "深夜")
}

const WEEKDAY_TAIL: &str = r"[一二三四五六日天1-7周星期礼拜、,，~至到\-]+";

/// 解析星期尾串：「一」「三五」「一至五」「周一至周五」「1、3」「1-5」。
/// 容忍「周X / 星期X / 礼拜X」前缀（如「一至周五」= 周一至周五）。
fn parse_weekday_tail(tail: &str) -> Vec<u32> {
    let mut out = Vec::new();
    let mut last: Option<u32> = None;
    let mut pending_range = false;
    for c in tail.chars() {
        if matches!(c, '周' | '星' | '期' | '礼' | '拜') {
            continue; // 前缀字，跳过
        }
        if c == '至' || c == '到' || c == '-' || c == '~' {
            pending_range = true;
            continue;
        }
        if let Some(wd) = weekday_char(c) {
            if pending_range {
                if let Some(l) = last {
                    let (a, b) = if wd >= l { (l, wd) } else { (wd, l) };
                    for d in a..=b {
                        if !out.contains(&d) {
                            out.push(d);
                        }
                    }
                }
                pending_range = false;
            } else if !out.contains(&wd) {
                out.push(wd);
            }
            last = Some(wd);
        }
    }
    out.sort_unstable();
    out
}

/// 解析快速录入文本。
pub fn parse(input: &str) -> ParsedInput {
    let original = input.trim().to_string();
    let mut s = original.clone();
    let mut matched: Vec<String> = Vec::new();
    let mut due: Option<DateTime<Local>> = None;
    let mut has_explicit_time = false;
    let mut date_only = false;
    let mut evening = false;
    let mut period_seen = false;
    let mut date_opt: Option<NaiveDate> = None;
    let mut hour_opt: Option<u32> = None;
    let mut minute_opt: Option<u32> = None;
    let mut advance_minutes: Option<i64> = None;
    let mut recurrence: Option<RecurrenceRuleInput> = None;

    // 1) 提前提醒：提前30分钟 / 提前2小时
    if let Some(g) = take(
        r"提前\s*(\d+|[一二三四五六七八九十百]+)\s*(分钟|小时|天)",
        &mut s,
        &mut matched,
    ) {
        let n = cn_num(g[0].as_deref().unwrap_or("")).unwrap_or(0);
        let unit = g[1].as_deref().unwrap_or("分钟");
        let mins = match unit {
            "小时" => n * 60,
            "天" => n * 1440,
            _ => n,
        };
        if mins > 0 {
            advance_minutes = Some(mins);
        }
    }

    // 2) 重复规则
    let weekly_days = |g: &[Option<String>]| parse_weekday_tail(g[0].as_deref().unwrap_or(""));
    if let Some(g) = take(
        &format!(r"每两(?:个)?(?:周|星期|礼拜)\s*({})", WEEKDAY_TAIL),
        &mut s,
        &mut matched,
    ) {
        let days = weekly_days(&g);
        if !days.is_empty() {
            recurrence = Some(RecurrenceRuleInput {
                freq: "weekly".into(),
                interval: 2,
                by_weekday: days,
                by_monthday: None,
            });
        }
    } else if let Some(g) = take(
        &format!(r"每(?:个)?(?:周|星期|礼拜)\s*({})", WEEKDAY_TAIL),
        &mut s,
        &mut matched,
    ) {
        let days = weekly_days(&g);
        if !days.is_empty() {
            recurrence = Some(RecurrenceRuleInput {
                freq: "weekly".into(),
                interval: 1,
                by_weekday: days,
                by_monthday: None,
            });
        }
    } else if let Some(g) = take(r"每(?:个)?月\s*(\d{1,2})\s*[日号]", &mut s, &mut matched) {
        let day = g[0]
            .as_deref()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(1);
        recurrence = Some(RecurrenceRuleInput {
            freq: "monthly".into(),
            interval: 1,
            by_weekday: vec![],
            by_monthday: Some(day.clamp(1, 31)),
        });
    } else if take(r"(每天|每日)", &mut s, &mut matched).is_some() {
        recurrence = Some(RecurrenceRuleInput {
            freq: "daily".into(),
            interval: 1,
            by_weekday: vec![],
            by_monthday: None,
        });
    }

    // 3) 相对时间：N 分钟后 / 半小时后 / 马上
    if due.is_none() {
        if let Some(g) = take(
            r"(\d+|[一二三四五六七八九十百]+)\s*(分钟|小时|天|周)后",
            &mut s,
            &mut matched,
        ) {
            let n = cn_num(g[0].as_deref().unwrap_or("")).unwrap_or(0);
            let unit = g[1].as_deref().unwrap_or("分钟");
            let delta = match unit {
                "分钟" => Duration::minutes(n),
                "小时" => Duration::hours(n),
                "天" => Duration::days(n),
                _ => Duration::weeks(n),
            };
            if n > 0 {
                due = Some(Local::now() + delta);
                has_explicit_time = true;
            }
        }
    }
    if due.is_none() && take(r"半小时后", &mut s, &mut matched).is_some() {
        due = Some(Local::now() + Duration::minutes(30));
        has_explicit_time = true;
    }
    if due.is_none() && take(r"马上|立刻", &mut s, &mut matched).is_some() {
        due = Some(Local::now() + Duration::minutes(5));
        has_explicit_time = true;
    }

    // 4) 日期词
    if due.is_none() {
        if let Some(g) = take(r"(大后天|后天|明天|明日|今晚|明晚|今天|今日)", &mut s, &mut matched) {
            let w = g[0].as_deref().unwrap_or("");
            let offset = match w {
                "大后天" => 3,
                "后天" | "明日" => 2,
                "明天" => 1,
                _ => 0,
            };
            date_opt = Some(Local::now().date_naive() + Duration::days(offset));
            if w == "今晚" || w == "明晚" {
                evening = true;
            }
        }
    }

    // 5) 星期表达：下周三 / 周三 / 本周五
    if due.is_none() && date_opt.is_none() {
        if let Some(g) = take(
            &format!(
                r"(下下周|下周|下个周|本周|这周|这个周|周|星期|礼拜)\s*({})",
                WEEKDAY_TAIL
            ),
            &mut s,
            &mut matched,
        ) {
            let scope = g[0].as_deref().unwrap_or("周");
            let days = parse_weekday_tail(g[1].as_deref().unwrap_or(""));
            if let Some(first) = days.first() {
                let today = Local::now().date_naive();
                let back = weekday_num(today) as i64 - 1;
                let monday = today - Duration::days(back);
                let base = match scope {
                    "下周" | "下个周" => monday + Duration::days(7),
                    "下下周" => monday + Duration::days(14),
                    _ => monday,
                };
                let mut d = base + Duration::days(*first as i64 - 1);
                if d < today {
                    d += Duration::days(7);
                }
                date_opt = Some(d);
            }
        }
    }

    // 6) 月日：3月5日
    if due.is_none() && date_opt.is_none() {
        if let Some(g) = take(r"(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]", &mut s, &mut matched) {
            let m = g[0].as_deref().and_then(|v| v.parse::<u32>().ok()).unwrap_or(1).clamp(1, 12);
            let d = g[1].as_deref().and_then(|v| v.parse::<u32>().ok()).unwrap_or(1).clamp(1, 31);
            let today = Local::now().date_naive();
            let mut y = today.year();
            if let Some(nd) = NaiveDate::from_ymd_opt(y, m, d) {
                if nd < today {
                    y += 1;
                }
                date_opt = NaiveDate::from_ymd_opt(y, m, d);
            }
        }
    }

    // 7) ISO / M-D
    if due.is_none() && date_opt.is_none() {
        if let Some(g) = take(r"(\d{4})-(\d{1,2})-(\d{1,2})", &mut s, &mut matched) {
            let y = g[0].as_deref().and_then(|v| v.parse().ok()).unwrap_or(2026);
            let m = g[1].as_deref().and_then(|v| v.parse::<u32>().ok()).unwrap_or(1).clamp(1, 12);
            let d = g[2].as_deref().and_then(|v| v.parse::<u32>().ok()).unwrap_or(1).clamp(1, 31);
            date_opt = NaiveDate::from_ymd_opt(y, m, d);
        }
    }
    if due.is_none() && date_opt.is_none() {
        if let Some(g) = take(r"\b(\d{1,2})-(\d{1,2})\b", &mut s, &mut matched) {
            let m = g[0].as_deref().and_then(|v| v.parse::<u32>().ok()).unwrap_or(1).clamp(1, 12);
            let d = g[1].as_deref().and_then(|v| v.parse::<u32>().ok()).unwrap_or(1).clamp(1, 31);
            let today = Local::now().date_naive();
            let mut y = today.year();
            if let Some(nd) = NaiveDate::from_ymd_opt(y, m, d) {
                if nd < today {
                    y += 1;
                }
                date_opt = NaiveDate::from_ymd_opt(y, m, d);
            }
        }
    }

    // 8) 时刻
    if due.is_none() {
        // 8a. HH:MM
        if let Some(g) = take(r"(\d{1,2}):(\d{2})", &mut s, &mut matched) {
            let h = g[0].as_deref().and_then(|v| v.parse::<u32>().ok()).unwrap_or(99);
            let m = g[1].as_deref().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
            if h < 24 && m < 60 {
                hour_opt = Some(h);
                minute_opt = Some(m);
                has_explicit_time = true;
            }
        }
        // 8b. 下午三点 / 3点半 / 8点15分 / 九点
        if hour_opt.is_none() {
            let pattern = r"(凌晨|早上|早晨|清晨|上午|中午|下午|傍晚|晚上|夜里|深夜)?\s*(\d{1,2}|[一二三四五六七八九十]+)\s*[点时]\s*(半|\d{1,2}|[一二三四五六七八九十]+)?\s*分?";
            let rx = compiled(pattern);
            let hit = {
                let caps = rx.captures(s.as_str());
                caps.map(|c| {
                    let whole = c.get(0).unwrap().as_str().to_string();
                    let period = c.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
                    let hour = c.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
                    let minute = c.get(3).map(|m| m.as_str().to_string());
                    (whole, period, hour, minute)
                })
            };
            if let Some((whole, period, hour_raw, minute_raw)) = hit {
                let mut consumed = false;
                if !period.is_empty() {
                    period_seen = true;
                }
                if let Some(mut h) = cn_num(&hour_raw) {
                    if h <= 24 {
                        let min = match minute_raw.as_deref() {
                            Some("半") => 30u32,
                            Some(v) => cn_num(v).map(|v| v as u32).unwrap_or(0),
                            None => 0,
                        };
                        if h == 24 {
                            h = 0;
                        }
                        if is_evening_period(&period) && h < 12 {
                            h += 12;
                        }
                        if h < 24 && min < 60 {
                            hour_opt = Some(h as u32);
                            minute_opt = Some(min);
                            has_explicit_time = true;
                            if is_evening_period(&period) {
                                evening = true;
                            }
                            consumed = true;
                        }
                    }
                }
                // 仅匹配到时段词（如「下午」）也消费掉，避免 8c 重复匹配
                if !consumed && !period.is_empty() {
                    consumed = true;
                }
                if consumed {
                    matched.push(whole.clone());
                    if let Some(pos) = s.find(&whole) {
                        s.replace_range(pos..pos + whole.len(), " ");
                    }
                }
            }
        }
        // 8c. 仅有时段词：下午 / 晚上
        if hour_opt.is_none() {
                   if let Some(g) = take(
            r"(凌晨|早上|早晨|清晨|上午|中午|下午|傍晚|晚上|夜里|深夜)",
            &mut s,
            &mut matched,
        ) {
                let period = g[0].as_deref().unwrap_or("");
                if let Some(h) = period_default_hour(period) {
                    hour_opt = Some(h);
                    has_explicit_time = true;
                    period_seen = true;
                    if is_evening_period(period) {
                        evening = true;
                    }
                }
            }
        }
    }

    // 9) 合成 due
    if due.is_none() {
        if let Some(rule) = recurrence.clone() {
            // 重复任务：从当前时刻起算第一次发生
            let now = Local::now();
            let time = hour_opt
                .zip(minute_opt)
                .and_then(|(h, m)| chrono::NaiveTime::from_hms_opt(h, m, 0))
                .unwrap_or_else(|| chrono::NaiveTime::from_hms_opt(9, 0, 0).unwrap());
            let after_naive = now.date_naive().and_time(time);
            let after = Local
                .from_local_datetime(&after_naive)
                .single()
                .unwrap_or(now);
            due = next_occurrence(
                &rule.freq,
                rule.interval,
                &rule.by_weekday,
                rule.by_monthday,
                Some(now.date_naive()),
                after,
            );
            has_explicit_time = hour_opt.is_some() || minute_opt.is_some();
        } else if hour_opt.is_some() || date_opt.is_some() {
            // 无日期词但识别到时刻 → 默认今天；无时刻 → 默认 09:00（date_only 标记）
            let date = date_opt.unwrap_or_else(|| Local::now().date_naive());
            let (mut h, m, explicit) = match (hour_opt, minute_opt) {
                (Some(h), Some(m)) => (h, m, true),
                (Some(h), None) => (h, 0, true),
                _ => {
                    if evening {
                        (20, 0, true)
                    } else {
                        (9, 0, false)
                    }
                }
            };
            // 「今晚 8 点」这类：时段词要求下午/晚上时，12 小时制 +12
            if evening && h < 12 {
                h += 12;
            }
            // 无时段词的裸时刻：1-6 点按下午处理（待办场景惯例），7-11 按上午
            if !period_seen && !evening && (1..=6).contains(&h) {
                h += 12;
            }
            let time = chrono::NaiveTime::from_hms_opt(h, m, 0)
                .unwrap_or_else(|| chrono::NaiveTime::from_hms_opt(9, 0, 0).unwrap());
            let naive = date.and_time(time);
            let local = Local
                .from_local_datetime(&naive)
                .single()
                .unwrap_or_else(|| Local::now());
            due = Some(local);
            has_explicit_time = has_explicit_time || explicit;
            date_only = !explicit;
        }
    }

    // 10) 标题清理
    let mut title = original.clone();
    for m in &matched {
        title = title.replace(m.as_str(), " ");
    }
    let title = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| {
            c.is_whitespace() || "，,。.、；;：:！!？?-—~".contains(c)
        })
        .to_string();
    let title = if title.is_empty() { original.clone() } else { title };

    ParsedInput {
        title,
        due_at: due,
        recurrence,
        advance_minutes,
        matched,
        has_explicit_time,
        date_only,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Weekday;

    fn p(s: &str) -> ParsedInput {
        parse(s)
    }

    #[test]
    fn parses_tomorrow_afternoon() {
        let r = p("明天下午三点开会");
        assert_eq!(r.title, "开会");
        let due = r.due_at.unwrap();
        let expect = Local::now().date_naive() + Duration::days(1);
        assert_eq!(due.date_naive(), expect);
        assert_eq!(due.time(), chrono::NaiveTime::from_hms_opt(15, 0, 0).unwrap());
        assert!(r.has_explicit_time);
        assert!(!r.date_only);
    }

    #[test]
    fn parses_day_after_evening() {
        let r = p("后天晚上八点检查代码");
        assert_eq!(r.title, "检查代码");
        let due = r.due_at.unwrap();
        assert_eq!(due.date_naive(), Local::now().date_naive() + Duration::days(2));
        assert_eq!(due.time(), chrono::NaiveTime::from_hms_opt(20, 0, 0).unwrap());
    }

    #[test]
    fn parses_weekly_morning() {
        let r = p("每周一早上九点提交周报");
        assert_eq!(r.title, "提交周报");
        let rule = r.recurrence.unwrap();
        assert_eq!(rule.freq, "weekly");
        assert_eq!(rule.by_weekday, vec![1]);
        let due = r.due_at.unwrap();
        assert_eq!(due.date_naive().weekday(), Weekday::Mon);
        assert_eq!(due.time(), chrono::NaiveTime::from_hms_opt(9, 0, 0).unwrap());
    }

    #[test]
    fn parses_relative_minutes() {
        let r = p("30 分钟后提醒我喝水");
        assert_eq!(r.title, "提醒我喝水");
        let due = r.due_at.unwrap();
        let diff = due - Local::now();
        assert!(diff.num_minutes() >= 29 && diff.num_minutes() <= 31);
        assert!(r.has_explicit_time);
    }

    #[test]
    fn parses_advance() {
        let r = p("提前30分钟 明天下午三点开会");
        assert_eq!(r.advance_minutes, Some(30));
        assert_eq!(r.title, "开会");
    }

    #[test]
    fn parses_tonight() {
        let r = p("今晚8点发布");
        let due = r.due_at.unwrap();
        assert_eq!(due.time(), chrono::NaiveTime::from_hms_opt(20, 0, 0).unwrap());
    }

    #[test]
    fn parses_next_week_weekday() {
        let r = p("下周三下午2点评审");
        let due = r.due_at.unwrap();
        assert_eq!(due.date_naive().weekday(), Weekday::Wed);
        assert!(due.date_naive() > Local::now().date_naive());
        assert_eq!(due.time(), chrono::NaiveTime::from_hms_opt(14, 0, 0).unwrap());
    }

    #[test]
    fn parses_monthly() {
        let r = p("每月3号还信用卡");
        let rule = r.recurrence.unwrap();
        assert_eq!(rule.freq, "monthly");
        assert_eq!(rule.by_monthday, Some(3));
        assert_eq!(r.title, "还信用卡");
    }

    #[test]
    fn parses_weekday_range() {
        let r = p("每周一至周五早上九点站会");
        let rule = r.recurrence.unwrap();
        assert_eq!(rule.by_weekday, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn parses_hh_mm() {
        let r = p("9:30 站立会");
        let due = r.due_at.unwrap();
        assert_eq!(due.time(), chrono::NaiveTime::from_hms_opt(9, 30, 0).unwrap());
        assert_eq!(r.title, "站立会");
    }

    #[test]
    fn parses_chinese_hour() {
        let r = p("明天十二点吃饭");
        let due = r.due_at.unwrap();
        assert_eq!(due.time(), chrono::NaiveTime::from_hms_opt(12, 0, 0).unwrap());
    }

    #[test]
    fn date_only_defaults_nine() {
        let r = p("明天交报告");
        assert_eq!(r.title, "交报告");
        assert!(r.date_only);
        assert!(!r.has_explicit_time);
        assert_eq!(r.due_at.unwrap().time(), chrono::NaiveTime::from_hms_opt(9, 0, 0).unwrap());
    }

    #[test]
    fn no_time_keeps_raw_title() {
        let r = p("买牛奶");
        assert_eq!(r.title, "买牛奶");
        assert!(r.due_at.is_none());
        assert!(r.matched.is_empty());
        assert!(!r.has_explicit_time);
    }

    #[test]
    fn parses_monthday_date() {
        let r = p("10月28日团建");
        let due = r.due_at.unwrap();
        assert_eq!(due.month(), 10);
        assert_eq!(due.day(), 28);
        assert_eq!(r.title, "团建");
    }

    #[test]
    fn parses_half_hour() {
        let r = p("三点半出发");
        assert_eq!(r.due_at.unwrap().time(), chrono::NaiveTime::from_hms_opt(15, 30, 0).unwrap());
    }

    #[test]
    fn parses_daily() {
        let r = p("每天晚上十点复盘");
        let rule = r.recurrence.unwrap();
        assert_eq!(rule.freq, "daily");
        assert_eq!(r.title, "复盘");
    }

    #[test]
    fn parses_biweekly() {
        let r = p("每两周周一开会");
        let rule = r.recurrence.unwrap();
        assert_eq!(rule.freq, "weekly");
        assert_eq!(rule.interval, 2);
        assert_eq!(rule.by_weekday, vec![1]);
    }

    #[test]
    fn parses_soon() {
        let r = p("马上提交");
        assert!(r.due_at.is_some());
        let diff = r.due_at.unwrap() - Local::now();
        assert!(diff.num_minutes() <= 6 && diff.num_minutes() >= 3);
    }
}
