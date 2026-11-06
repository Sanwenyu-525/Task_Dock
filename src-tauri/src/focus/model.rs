//! 专注与休息模块的公共数据模型：枚举、偏好、快照与历史条目。
//!
//! 时间模型约定（与 `core.rs` 一致）：
//! - `accumulated_ms` 是**已确认有效时长**（不含暂停、不含无法确认的休眠区间）；
//! - `running_since` 是当前运行片段的**墙钟**锚点，只用于跨进程恢复与展示；
//! - 进程内推进使用单调时钟（`std::time::Instant`），墙钟跳变不会被计成专注时长。

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::AppResult;

/// 会话类型。休息分为短休与长休，长休按番茄轮次触发。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Focus,
    ShortBreak,
    LongBreak,
}

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Focus => "focus",
            Self::ShortBreak => "short_break",
            Self::LongBreak => "long_break",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "focus" => Some(Self::Focus),
            "short_break" => Some(Self::ShortBreak),
            "long_break" => Some(Self::LongBreak),
            _ => None,
        }
    }

    pub fn is_break(self) -> bool {
        matches!(self, Self::ShortBreak | Self::LongBreak)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Focus => "专注",
            Self::ShortBreak => "短休息",
            Self::LongBreak => "长休息",
        }
    }
}

/// 会话状态。`Completed` 只表示本轮计时走完或用户主动结束，**不表示任务完成**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Focusing,
    Paused,
    Break,
    Completed,
    Cancelled,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Focusing => "focusing",
            Self::Paused => "paused",
            Self::Break => "break",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "focusing" => Some(Self::Focusing),
            "paused" => Some(Self::Paused),
            "break" => Some(Self::Break),
            "completed" => Some(Self::Completed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Focusing | Self::Paused | Self::Break)
    }
}

/// 专注偏好。全部落在 `application_settings`，键名带 `focus_` 前缀。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FocusPrefs {
    pub focus_minutes: u32,
    pub short_break_minutes: u32,
    pub long_break_minutes: u32,
    pub long_break_every: u32,
    /// 专注结束后自动开始休息（默认关闭）。
    pub auto_start_break: bool,
    /// 休息结束后自动开始下一轮专注（默认关闭）。
    pub auto_start_next: bool,
    /// 久坐提醒开关（不监控键鼠，仅按时间提醒）。
    pub sedentary_enabled: bool,
    pub sedentary_interval_minutes: u32,
}

impl Default for FocusPrefs {
    fn default() -> Self {
        Self {
            focus_minutes: 25,
            short_break_minutes: 5,
            long_break_minutes: 15,
            long_break_every: 4,
            auto_start_break: false,
            auto_start_next: false,
            sedentary_enabled: false,
            sedentary_interval_minutes: 60,
        }
    }
}

impl FocusPrefs {
    pub fn validate(&self) -> AppResult<()> {
        check_range("专注时长", self.focus_minutes, 5, 180)?;
        check_range("短休息时长", self.short_break_minutes, 1, 60)?;
        check_range("长休息时长", self.long_break_minutes, 5, 240)?;
        check_range("长休息轮次", self.long_break_every, 2, 12)?;
        check_range("久坐提醒间隔", self.sedentary_interval_minutes, 15, 240)?;
        Ok(())
    }
}

fn check_range(label: &str, value: u32, min: u32, max: u32) -> AppResult<()> {
    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(crate::error::AppError::Validation(format!(
            "{label}必须在 {min}..={max} 之间（收到 {value}）"
        )))
    }
}

/// 偏好局部更新：`None` 表示保持原值。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FocusPrefsPatch {
    pub focus_minutes: Option<u32>,
    pub short_break_minutes: Option<u32>,
    pub long_break_minutes: Option<u32>,
    pub long_break_every: Option<u32>,
    pub auto_start_break: Option<bool>,
    pub auto_start_next: Option<bool>,
    pub sedentary_enabled: Option<bool>,
    pub sedentary_interval_minutes: Option<u32>,
}

impl FocusPrefsPatch {
    pub fn apply_to(&self, prefs: &mut FocusPrefs) {
        if let Some(v) = self.focus_minutes {
            prefs.focus_minutes = v;
        }
        if let Some(v) = self.short_break_minutes {
            prefs.short_break_minutes = v;
        }
        if let Some(v) = self.long_break_minutes {
            prefs.long_break_minutes = v;
        }
        if let Some(v) = self.long_break_every {
            prefs.long_break_every = v;
        }
        if let Some(v) = self.auto_start_break {
            prefs.auto_start_break = v;
        }
        if let Some(v) = self.auto_start_next {
            prefs.auto_start_next = v;
        }
        if let Some(v) = self.sedentary_enabled {
            prefs.sedentary_enabled = v;
        }
        if let Some(v) = self.sedentary_interval_minutes {
            prefs.sedentary_interval_minutes = v;
        }
    }
}

pub const KEY_FOCUS_MINUTES: &str = "focus_focus_minutes";
pub const KEY_SHORT_BREAK: &str = "focus_short_break_minutes";
pub const KEY_LONG_BREAK: &str = "focus_long_break_minutes";
pub const KEY_LONG_EVERY: &str = "focus_long_break_every";
pub const KEY_AUTO_BREAK: &str = "focus_auto_start_break";
pub const KEY_AUTO_NEXT: &str = "focus_auto_start_next";
pub const KEY_SEDENTARY_ENABLED: &str = "focus_sedentary_enabled";
pub const KEY_SEDENTARY_INTERVAL: &str = "focus_sedentary_interval_minutes";
pub const KEY_SEDENTARY_NEXT_AT: &str = "focus_sedentary_next_at";
pub const KEY_ROUNDS_SINCE_LONG: &str = "focus_rounds_since_long";

fn read_u32(db: &Db, key: &str, fallback: u32) -> AppResult<u32> {
    match db.get_setting(key)? {
        Some(v) => Ok(v.as_u64().map(|n| n as u32).unwrap_or(fallback)),
        None => Ok(fallback),
    }
}

fn read_bool(db: &Db, key: &str, fallback: bool) -> AppResult<bool> {
    match db.get_setting(key)? {
        Some(v) => Ok(v.as_bool().unwrap_or(fallback)),
        None => Ok(fallback),
    }
}

impl FocusPrefs {
    pub fn load(db: &Db) -> AppResult<Self> {
        let defaults = Self::default();
        let mut prefs = Self {
            focus_minutes: read_u32(db, KEY_FOCUS_MINUTES, defaults.focus_minutes)?,
            short_break_minutes: read_u32(db, KEY_SHORT_BREAK, defaults.short_break_minutes)?,
            long_break_minutes: read_u32(db, KEY_LONG_BREAK, defaults.long_break_minutes)?,
            long_break_every: read_u32(db, KEY_LONG_EVERY, defaults.long_break_every)?,
            auto_start_break: read_bool(db, KEY_AUTO_BREAK, defaults.auto_start_break)?,
            auto_start_next: read_bool(db, KEY_AUTO_NEXT, defaults.auto_start_next)?,
            sedentary_enabled: read_bool(db, KEY_SEDENTARY_ENABLED, defaults.sedentary_enabled)?,
            sedentary_interval_minutes: read_u32(
                db,
                KEY_SEDENTARY_INTERVAL,
                defaults.sedentary_interval_minutes,
            )?,
        };
        // 损坏或越界的历史值回落到默认值，避免启动即失败。
        if prefs.validate().is_err() {
            prefs = defaults;
        }
        Ok(prefs)
    }

    pub fn persist(&self, db: &Db) -> AppResult<()> {
        self.validate()?;
        db.set_setting(KEY_FOCUS_MINUTES, serde_json::json!(self.focus_minutes))?;
        db.set_setting(KEY_SHORT_BREAK, serde_json::json!(self.short_break_minutes))?;
        db.set_setting(KEY_LONG_BREAK, serde_json::json!(self.long_break_minutes))?;
        db.set_setting(KEY_LONG_EVERY, serde_json::json!(self.long_break_every))?;
        db.set_setting(KEY_AUTO_BREAK, serde_json::json!(self.auto_start_break))?;
        db.set_setting(KEY_AUTO_NEXT, serde_json::json!(self.auto_start_next))?;
        db.set_setting(
            KEY_SEDENTARY_ENABLED,
            serde_json::json!(self.sedentary_enabled),
        )?;
        db.set_setting(
            KEY_SEDENTARY_INTERVAL,
            serde_json::json!(self.sedentary_interval_minutes),
        )?;
        Ok(())
    }
}

/// 活跃会话对前端的只读视图。
#[derive(Debug, Clone, Serialize)]
pub struct FocusSessionView {
    pub id: String,
    pub kind: SessionKind,
    pub state: SessionState,
    pub task_id: Option<String>,
    pub task_title: String,
    /// 任务被硬删除后历史仍保留快照标题，这里标记「任务已删除」。
    pub task_deleted: bool,
    pub planned_seconds: i64,
    pub extension_seconds: i64,
    pub accumulated_ms: i64,
    /// 服务端按请求时刻计算的剩余有效毫秒（前端仅用于首帧，随后按共享时钟推算）。
    pub remaining_ms: i64,
    pub started_at: String,
    pub running_since: Option<String>,
    pub paused_at: Option<String>,
    pub pause_reason: Option<String>,
    pub round_index: i64,
    pub clock_jumps: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct TodayStats {
    pub day: String,
    pub focus_ms: i64,
    pub break_ms: i64,
    pub completed_focus: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SedentaryView {
    pub enabled: bool,
    pub interval_minutes: u32,
    pub next_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FocusSnapshot {
    pub active: Option<FocusSessionView>,
    pub prefs: FocusPrefs,
    pub today: TodayStats,
    pub rounds_since_long: i64,
    pub sedentary: SedentaryView,
    pub server_now: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FocusHistoryItem {
    pub id: String,
    pub kind: SessionKind,
    pub state: SessionState,
    pub task_id: Option<String>,
    pub task_title: String,
    pub task_deleted: bool,
    pub planned_seconds: i64,
    pub accumulated_ms: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub round_index: i64,
}

/// RFC3339（毫秒精度、UTC）序列化，供 SQLite 文本列与前端 `Date.parse` 共用。
pub fn ts(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn parse_ts(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// 本机时区的日期键（`YYYY-MM-DD`）。跨午夜与东八区用户按本地日历归属。
pub fn local_day(dt: DateTime<Utc>) -> String {
    dt.with_timezone(&chrono::Local)
        .date_naive()
        .format("%Y-%m-%d")
        .to_string()
}

pub fn local_day_start(day: &str) -> Option<DateTime<Utc>> {
    let date = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    let naive = date.and_hms_opt(0, 0, 0)?;
    let local = chrono::Local.from_local_datetime(&naive).single()?;
    Some(local.with_timezone(&Utc))
}
