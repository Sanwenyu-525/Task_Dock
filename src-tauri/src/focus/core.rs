//! 专注状态机与时间核算。
//!
//! 关键不变量：
//! 1. 同一时刻最多一个活跃会话（内存 `active` + 数据库 `active=1` 唯一索引双保险）。
//! 2. 进程内有效时长只由单调时钟增量累加，墙钟只用于记录锚点、恢复与展示。
//! 3. 两次 tick 间隔 ≥ [`UNCONFIRMED_GAP`] 视为进程被挂起/休眠：**不补记这段时长**，
//!    直接转为暂停（`pause_reason = unconfirmed_gap`），避免虚构专注时间。
//! 4. 自然走完计划时长才计入番茄轮次；手动结束/放弃只记录有效时长，不改任务状态。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::json;

use super::model::{
    local_day, ts, FocusHistoryItem, FocusPrefs, FocusPrefsPatch, FocusSessionView, FocusSnapshot,
    SedentaryView, SessionKind, SessionState, KEY_ROUNDS_SINCE_LONG,
    KEY_SEDENTARY_NEXT_AT,
};
use super::store::{self, SessionRecord};
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 恢复节点落库间隔：不是每秒写库，崩溃最多损失 30 秒已确认时长。
pub const PERSIST_INTERVAL: Duration = Duration::from_secs(30);
/// 两次 tick 间隔达到该阈值即视为「无法确认的挂起区间」，不补记时长（≥ 语义，
/// 与模块级契约「间隔 ≥10 秒」一致）。
pub const UNCONFIRMED_GAP: Duration = Duration::from_secs(10);
/// 墙钟与单调时钟偏差超过该阈值时记录一次时间跳变（仅诊断，不影响有效时长）。
pub const CLOCK_JUMP_THRESHOLD_MS: i64 = 5_000;

#[derive(Debug, Clone)]
pub struct ActiveSession {
    pub rec: SessionRecord,
    pub running_since_mono: Option<Instant>,
    pub last_tick_mono: Instant,
    /// 上次落库时的 `accumulated_ms`，用于判断是否到了 30 秒恢复节点。
    pub persisted_ms: i64,
    pub clock_jumps: u32,
}

impl ActiveSession {
    pub fn from_record(rec: SessionRecord, mono: Instant) -> Self {
        let persisted_ms = rec.accumulated_ms;
        Self {
            rec,
            running_since_mono: None,
            last_tick_mono: mono,
            persisted_ms,
            clock_jumps: 0,
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self.rec.state, SessionState::Focusing | SessionState::Break)
            && self.running_since_mono.is_some()
    }

    pub fn planned_ms(&self) -> i64 {
        self.rec.planned_seconds.saturating_mul(1000)
    }

    pub fn remaining_ms(&self, mono: Instant) -> i64 {
        let segment = if self.is_running() {
            mono.saturating_duration_since(self.last_tick_mono)
                .as_millis() as i64
        } else {
            0
        };
        (self.planned_ms() - self.rec.accumulated_ms - segment).max(0)
    }

    fn view(&self, mono: Instant, task_deleted: bool) -> FocusSessionView {
        FocusSessionView {
            id: self.rec.id.clone(),
            kind: self.rec.kind,
            state: self.rec.state,
            task_id: self.rec.task_id.clone(),
            task_title: self.rec.task_title.clone(),
            task_deleted,
            planned_seconds: self.rec.planned_seconds,
            extension_seconds: self.rec.extension_seconds,
            accumulated_ms: self.rec.accumulated_ms,
            remaining_ms: self.remaining_ms(mono),
            started_at: ts(self.rec.started_at),
            running_since: self.rec.running_since.map(ts),
            paused_at: self.rec.paused_at.map(ts),
            pause_reason: self.rec.pause_reason.clone(),
            round_index: self.rec.round_index,
            clock_jumps: self.clock_jumps,
        }
    }
}

#[derive(Debug, Default, Clone)]
struct PendingDaily {
    focus_ms: i64,
    break_ms: i64,
    completed: i64,
}

#[derive(Debug, Clone, Default)]
pub struct TickEffects {
    pub changed: bool,
    pub paused_due_to_gap: bool,
    pub completed: Option<CompletedInfo>,
    pub auto_started: Option<SessionKind>,
    pub sedentary_due: bool,
}

#[derive(Debug, Clone)]
pub struct CompletedInfo {
    pub session_id: String,
    pub kind: SessionKind,
    pub minutes: i64,
    pub task_title: String,
    pub round_index: i64,
    pub next_break_minutes: u32,
}

enum CreditOutcome {
    None,
    Credited(i64),
    UncertainGap,
}

pub struct FocusCore {
    active: Option<ActiveSession>,
    loaded: bool,
    prefs: FocusPrefs,
    pending: HashMap<String, PendingDaily>,
    rounds_since_long: i64,
    sedentary_next: Option<DateTime<Utc>>,
}

impl Default for FocusCore {
    fn default() -> Self {
        Self::new()
    }
}

impl FocusCore {
    pub fn new() -> Self {
        Self {
            active: None,
            loaded: false,
            prefs: FocusPrefs::default(),
            pending: HashMap::new(),
            rounds_since_long: 0,
            sedentary_next: None,
        }
    }

    /// 首次使用时从数据库恢复：上次进程退出时仍在运行的会话转为暂停，**不补记退出区间**。
    pub fn ensure_loaded(&mut self, db: &Db, now: DateTime<Utc>, mono: Instant) -> AppResult<()> {
        if self.loaded {
            return Ok(());
        }
        self.prefs = FocusPrefs::load(db)?;
        self.rounds_since_long = db
            .get_setting(KEY_ROUNDS_SINCE_LONG)?
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            .max(0);
        self.sedentary_next = db
            .get_setting(KEY_SEDENTARY_NEXT_AT)?
            .and_then(|v| v.as_str().and_then(super::model::parse_ts));
        if let Some(mut rec) = store::load_active(db)? {
            if matches!(rec.state, SessionState::Focusing | SessionState::Break) {
                rec.state = SessionState::Paused;
                rec.pause_reason = Some("app_restart".to_string());
                rec.paused_at = Some(now);
                rec.running_since = None;
                db.with_conn(|conn| store::update_session(conn, &rec, now))?;
            }
            self.active = Some(ActiveSession::from_record(rec, mono));
        }
        // 应用关闭期间到期的久坐提醒不在启动瞬间弹出，顺延一个完整间隔。
        if let Some(next) = self.sedentary_next {
            if next <= now {
                self.set_sedentary_next(db, now)?;
            }
        }
        if self.prefs.sedentary_enabled && self.sedentary_next.is_none() {
            self.set_sedentary_next(db, now)?;
        }
        self.loaded = true;
        Ok(())
    }

    pub fn snapshot(
        &self,
        db: &Db,
        now: DateTime<Utc>,
        mono: Instant,
    ) -> AppResult<FocusSnapshot> {
        let day = local_day(now);
        let mut today = store::read_today(db, &day)?;
        if let Some(pending) = self.pending.get(&day) {
            today.focus_ms += pending.focus_ms;
            today.break_ms += pending.break_ms;
            today.completed_focus += pending.completed;
        }
        let active = match self.active.as_ref() {
            Some(a) => {
                let task_deleted = match a.rec.task_id.as_deref() {
                    Some(id) => db.with_conn(|conn| store::task_title(conn, id))?.is_none(),
                    None => false,
                };
                Some(a.view(mono, task_deleted))
            }
            None => None,
        };
        Ok(FocusSnapshot {
            active,
            prefs: self.prefs.clone(),
            today,
            rounds_since_long: self.rounds_since_long,
            sedentary: SedentaryView {
                enabled: self.prefs.sedentary_enabled,
                interval_minutes: self.prefs.sedentary_interval_minutes,
                next_at: self.sedentary_next.map(ts),
            },
            server_now: ts(now),
        })
    }

    pub fn history(&self, db: &Db, limit: u32) -> AppResult<Vec<FocusHistoryItem>> {
        store::list_history(db, limit)
    }

    /// 开始专注。已有活跃会话时不新建，返回 `false`（重复点击安全）。
    pub fn start_focus(
        &mut self,
        db: &Db,
        task_id: Option<String>,
        now: DateTime<Utc>,
        mono: Instant,
    ) -> AppResult<bool> {
        self.reload_if_active_in_db(db, mono)?;
        if self.active.is_some() {
            return Ok(false);
        }
        let task_id = task_id.filter(|id| !id.trim().is_empty());
        let (task_id, task_title) = match task_id {
            Some(id) => match db.with_conn(|conn| store::task_title(conn, &id))? {
                Some(title) => (Some(id), title),
                None => {
                    return Err(AppError::Validation(
                        "所选任务不存在或已被删除".to_string(),
                    ))
                }
            },
            None => (None, String::new()),
        };
        let planned = (self.prefs.focus_minutes as i64).saturating_mul(60);
        let rec = SessionRecord {
            id: uuid::Uuid::new_v4().to_string(),
            kind: SessionKind::Focus,
            state: SessionState::Focusing,
            task_id,
            task_title,
            planned_seconds: planned,
            extension_seconds: 0,
            accumulated_ms: 0,
            started_at: now,
            running_since: Some(now),
            last_tick_at: Some(now),
            paused_at: None,
            pause_reason: None,
            ended_at: None,
            round_index: (self.rounds_since_long + 1).max(1),
        };
        db.with_conn(|conn| store::insert_session(conn, &rec, now))?;
        self.active = Some(self.running_from_record(rec, mono));
        Ok(true)
    }

    /// 开始休息。长休由 `rounds_since_long` 与偏好决定；开始长休后轮次归零。
    pub fn start_break(
        &mut self,
        db: &Db,
        now: DateTime<Utc>,
        mono: Instant,
    ) -> AppResult<bool> {
        self.reload_if_active_in_db(db, mono)?;
        if self.active.is_some() {
            return Ok(false);
        }
        let long = self.rounds_since_long >= self.prefs.long_break_every as i64;
        let (kind, minutes) = if long {
            (
                SessionKind::LongBreak,
                self.prefs.long_break_minutes.max(1) as i64,
            )
        } else {
            (
                SessionKind::ShortBreak,
                self.prefs.short_break_minutes.max(1) as i64,
            )
        };
        let rec = SessionRecord {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            state: SessionState::Break,
            task_id: None,
            task_title: String::new(),
            planned_seconds: minutes.saturating_mul(60),
            extension_seconds: 0,
            accumulated_ms: 0,
            started_at: now,
            running_since: Some(now),
            last_tick_at: Some(now),
            paused_at: None,
            pause_reason: None,
            ended_at: None,
            round_index: self.rounds_since_long.max(1),
        };
        db.with_conn(|conn| store::insert_session(conn, &rec, now))?;
        self.active = Some(self.running_from_record(rec, mono));
        if long {
            self.rounds_since_long = 0;
            db.set_setting(KEY_ROUNDS_SINCE_LONG, json!(0))?;
        }
        // 起身休息视为打断久坐，重新计时（仅在启用久坐提醒时维护该键）。
        if self.prefs.sedentary_enabled {
            self.set_sedentary_next(db, now)?;
        }
        Ok(true)
    }

    pub fn pause(
        &mut self,
        db: &Db,
        now: DateTime<Utc>,
        mono: Instant,
    ) -> AppResult<bool> {
        let Some(mut active) = self.active.take() else {
            return Ok(false);
        };
        if !active.is_running() {
            self.active = Some(active);
            return Ok(false);
        }
        let kind = active.rec.kind;
        let credit = credit_segment(&mut active, now, mono);
        if let CreditOutcome::Credited(ms) = credit {
            if ms > 0 {
                self.add_pending(kind, ms, &local_day(now));
            }
        }
        active.rec.state = SessionState::Paused;
        active.rec.paused_at = Some(now);
        active.rec.pause_reason = Some("manual".to_string());
        active.rec.running_since = None;
        active.running_since_mono = None;
        // 暂停也是状态变化，立即落库（含累计时长）。
        self.persist_active_for(db, &mut active, now)?;
        self.active = Some(active);
        Ok(true)
    }

    pub fn resume(
        &mut self,
        db: &Db,
        now: DateTime<Utc>,
        mono: Instant,
    ) -> AppResult<bool> {
        let Some(mut active) = self.active.take() else {
            return Ok(false);
        };
        if active.rec.state != SessionState::Paused {
            self.active = Some(active);
            return Ok(false);
        }
        active.rec.state = if active.rec.kind.is_break() {
            SessionState::Break
        } else {
            SessionState::Focusing
        };
        active.rec.paused_at = None;
        active.rec.pause_reason = None;
        active.rec.running_since = Some(now);
        active.rec.last_tick_at = Some(now);
        active.running_since_mono = Some(mono);
        active.last_tick_mono = mono;
        self.persist_active_for(db, &mut active, now)?;
        self.active = Some(active);
        Ok(true)
    }

    /// 手动结束：记录有效时长并标记 `completed`，但**不计入番茄轮次**、不改任务状态。
    pub fn finish(&mut self, db: &Db, now: DateTime<Utc>, mono: Instant) -> AppResult<bool> {
        if self.active.is_none() {
            return Ok(false);
        }
        self.close_active(db, now, mono, SessionState::Completed, false, false)?;
        Ok(true)
    }

    /// 放弃本次：记录已发生的有效时长，但不计入轮次、不产生完成通知。
    pub fn cancel(&mut self, db: &Db, now: DateTime<Utc>, mono: Instant) -> AppResult<bool> {
        if self.active.is_none() {
            return Ok(false);
        }
        self.close_active(db, now, mono, SessionState::Cancelled, false, false)?;
        Ok(true)
    }

    pub fn extend_break(
        &mut self,
        db: &Db,
        minutes: u32,
        now: DateTime<Utc>,
    ) -> AppResult<bool> {
        if !(1..=120).contains(&minutes) {
            return Err(AppError::Validation(
                "延长休息分钟数必须在 1..=120 之间".to_string(),
            ));
        }
        let Some(mut active) = self.active.take() else {
            return Ok(false);
        };
        if !active.rec.kind.is_break() {
            self.active = Some(active);
            return Err(AppError::Conflict("当前会话不是休息".to_string()));
        }
        active.rec.planned_seconds += minutes as i64 * 60;
        active.rec.extension_seconds += minutes as i64 * 60;
        self.persist_active_for(db, &mut active, now)?;
        self.active = Some(active);
        Ok(true)
    }

    pub fn skip_break(
        &mut self,
        db: &Db,
        now: DateTime<Utc>,
        mono: Instant,
    ) -> AppResult<bool> {
        let Some(active) = self.active.as_ref() else {
            return Ok(false);
        };
        if !active.rec.kind.is_break() {
            return Err(AppError::Conflict("当前会话不是休息".to_string()));
        }
        self.close_active(db, now, mono, SessionState::Cancelled, false, false)?;
        Ok(true)
    }

    pub fn update_prefs(
        &mut self,
        db: &Db,
        patch: FocusPrefsPatch,
        now: DateTime<Utc>,
    ) -> AppResult<FocusPrefs> {
        let mut prefs = self.prefs.clone();
        patch.apply_to(&mut prefs);
        prefs.validate()?;
        prefs.persist(db)?;
        // 间隔变更必须从保存时刻按新间隔重排，否则旧计划会一直生效到下一次触发；
        // 间隔未变时保留现有 next_at（包括用户「延后 30 分钟」的结果）。
        let interval_changed =
            prefs.sedentary_interval_minutes != self.prefs.sedentary_interval_minutes;
        self.prefs = prefs.clone();
        if !prefs.sedentary_enabled {
            if self.sedentary_next.is_some() {
                self.sedentary_next = None;
                db.set_setting(KEY_SEDENTARY_NEXT_AT, json!(null))?;
            }
        } else if self.sedentary_next.is_none() || interval_changed {
            self.set_sedentary_next(db, now)?;
        }
        Ok(prefs)
    }

    pub fn snooze_sedentary(
        &mut self,
        db: &Db,
        minutes: u32,
        now: DateTime<Utc>,
    ) -> AppResult<bool> {
        if !(5..=240).contains(&minutes) {
            return Err(AppError::Validation(
                "延后久坐提醒分钟数必须在 5..=240 之间".to_string(),
            ));
        }
        if !self.prefs.sedentary_enabled {
            return Ok(false);
        }
        self.set_sedentary_next_minutes(db, now, minutes)?;
        Ok(true)
    }

    /// 调度器每秒调用一次：推进有效时长、检测无法确认的挂起区间、处理完成与久坐提醒。
    pub fn tick(
        &mut self,
        db: &Db,
        now: DateTime<Utc>,
        mono: Instant,
    ) -> AppResult<TickEffects> {
        let mut fx = TickEffects::default();
        let day = local_day(now);
        let mut natural_kind: Option<SessionKind> = None;

        if let Some(mut active) = self.active.take() {
            if active.is_running() {
                let kind = active.rec.kind;
                match credit_segment(&mut active, now, mono) {
                    CreditOutcome::Credited(ms) => {
                        if ms > 0 {
                            self.add_pending(kind, ms, &day);
                        }
                    }
                    CreditOutcome::UncertainGap => {
                        pause_with_reason(&mut active, now, "unconfirmed_gap");
                        self.persist_active_for(db, &mut active, now)?;
                        fx.changed = true;
                        fx.paused_due_to_gap = true;
                    }
                    CreditOutcome::None => {}
                }
            }
            if active.rec.state.is_active()
                && active.rec.accumulated_ms >= active.planned_ms()
            {
                natural_kind = Some(active.rec.kind);
                let info =
                    self.close_record(db, active, now, SessionState::Completed, true, true)?;
                fx.completed = info;
                fx.changed = true;
            } else {
                if active.is_running()
                    && active.rec.accumulated_ms - active.persisted_ms
                        >= PERSIST_INTERVAL.as_millis() as i64
                {
                    self.persist_active_for(db, &mut active, now)?;
                    fx.changed = false; // 30 秒恢复点不需要刷新 UI
                }
                self.active = Some(active);
            }
        }

        if let Some(kind) = natural_kind {
            // 自动开始只是完成后的附加动作：它失败时不能丢弃已提交的完成效果
            // （fx.completed / fx.changed 仍需由外层发出），只记录日志。
            if kind == SessionKind::Focus && self.prefs.auto_start_break {
                match self.start_break(db, now, mono) {
                    Ok(true) => {
                        fx.auto_started =
                            Some(self.active_kind().unwrap_or(SessionKind::ShortBreak));
                    }
                    Ok(false) => {}
                    Err(err) => tracing::warn!("专注完成后自动开始休息失败: {}", err),
                }
            } else if kind.is_break() && self.prefs.auto_start_next {
                match self.start_focus(db, None, now, mono) {
                    Ok(true) => fx.auto_started = Some(SessionKind::Focus),
                    Ok(false) => {}
                    Err(err) => tracing::warn!("休息结束后自动开始专注失败: {}", err),
                }
            }
        }

        if self.prefs.sedentary_enabled {
            if self.sedentary_next.is_none() {
                self.set_sedentary_next(db, now)?;
            } else if self.sedentary_next.map(|next| next <= now).unwrap_or(false) {
                fx.sedentary_due = true;
                self.set_sedentary_next(db, now)?;
                let body = format!(
                    "已连续工作约 {} 分钟，起身活动一下。",
                    self.prefs.sedentary_interval_minutes
                );
                let occurrence = ts(now);
                let id = format!("focus-sedentary-{occurrence}");
                db.with_conn(|conn| {
                    store::insert_notification(
                        conn,
                        &id,
                        "focus",
                        "久坐提醒",
                        &body,
                        "focus",
                        "sedentary",
                        &occurrence,
                        now,
                    )
                })?;
            }
        }

        Ok(fx)
    }

    fn reload_if_active_in_db(&mut self, db: &Db, mono: Instant) -> AppResult<()> {
        if self.active.is_some() {
            return Ok(());
        }
        if let Some(rec) = store::load_active(db)? {
            self.active = Some(ActiveSession::from_record(rec, mono));
        }
        Ok(())
    }

    fn running_from_record(&self, rec: SessionRecord, mono: Instant) -> ActiveSession {
        let mut active = ActiveSession::from_record(rec, mono);
        active.running_since_mono = active.rec.running_since.map(|_| mono);
        active
    }

    fn active_kind(&self) -> Option<SessionKind> {
        self.active.as_ref().map(|a| a.rec.kind)
    }

    fn add_pending(&mut self, kind: SessionKind, delta_ms: i64, day: &str) {
        if delta_ms <= 0 {
            return;
        }
        let entry = self.pending.entry(day.to_string()).or_default();
        if kind.is_break() {
            entry.break_ms += delta_ms;
        } else {
            entry.focus_ms += delta_ms;
        }
    }

    fn add_completed(&mut self, day: &str) {
        self.pending.entry(day.to_string()).or_default().completed += 1;
    }

    fn persist_active_for(
        &mut self,
        db: &Db,
        active: &mut ActiveSession,
        now: DateTime<Utc>,
    ) -> AppResult<()> {
        let rec = active.rec.clone();
        let pending = self.pending.clone();
        let result = db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            store::update_session(&tx, &rec, now)?;
            flush_pending(&tx, &pending, now)?;
            tx.commit()?;
            Ok(())
        });
        if result.is_ok() {
            self.pending.clear();
            active.persisted_ms = active.rec.accumulated_ms;
        }
        result
    }

    fn close_active(
        &mut self,
        db: &Db,
        now: DateTime<Utc>,
        mono: Instant,
        state: SessionState,
        natural: bool,
        count_round: bool,
    ) -> AppResult<Option<CompletedInfo>> {
        let Some(mut active) = self.active.take() else {
            return Ok(None);
        };
        if active.is_running() {
            let kind = active.rec.kind;
            if let CreditOutcome::Credited(ms) = credit_segment(&mut active, now, mono) {
                if ms > 0 {
                    self.add_pending(kind, ms, &local_day(now));
                }
            }
        }
        self.close_record(db, active, now, state, natural, count_round)
    }

    fn close_record(
        &mut self,
        db: &Db,
        mut active: ActiveSession,
        now: DateTime<Utc>,
        state: SessionState,
        natural: bool,
        count_round: bool,
    ) -> AppResult<Option<CompletedInfo>> {
        let day = local_day(now);
        let kind = active.rec.kind;
        if state == SessionState::Completed {
            let planned = active.planned_ms();
            if natural {
                active.rec.accumulated_ms = active.rec.accumulated_ms.min(planned);
            }
        }
        active.rec.state = state;
        active.rec.ended_at = Some(now);
        active.rec.running_since = None;
        active.rec.paused_at = None;
        active.running_since_mono = None;

        let mut info = None;
        if natural {
            if state == SessionState::Completed {
                if count_round && kind == SessionKind::Focus {
                    self.rounds_since_long += 1;
                    self.add_completed(&day);
                }
                let next_break = if self.rounds_since_long >= self.prefs.long_break_every as i64
                {
                    self.prefs.long_break_minutes
                } else {
                    self.prefs.short_break_minutes
                };
                info = Some(CompletedInfo {
                    session_id: active.rec.id.clone(),
                    kind,
                    minutes: (active.rec.accumulated_ms / 60_000).max(0),
                    task_title: active.rec.task_title.clone(),
                    round_index: active.rec.round_index,
                    next_break_minutes: next_break,
                });
            }
        }

        let pending = self.pending.clone();
        let rounds = self.rounds_since_long;
        let rec = active.rec.clone();
        let info_for_db = info.clone();
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            store::update_session(&tx, &rec, now)?;
            flush_pending(&tx, &pending, now)?;
            if count_round {
                store::upsert_setting(
                    &tx,
                    KEY_ROUNDS_SINCE_LONG,
                    &json!(rounds),
                    now,
                )?;
            }
            if let Some(done) = &info_for_db {
                push_completion_notification(&tx, done, now)?;
            }
            tx.commit()?;
            Ok(())
        })?;
        self.pending.clear();
        Ok(info)
    }

    fn set_sedentary_next(&mut self, db: &Db, now: DateTime<Utc>) -> AppResult<()> {
        let minutes = self.prefs.sedentary_interval_minutes;
        self.set_sedentary_next_minutes(db, now, minutes)
    }

    fn set_sedentary_next_minutes(
        &mut self,
        db: &Db,
        now: DateTime<Utc>,
        minutes: u32,
    ) -> AppResult<()> {
        let next = now + ChronoDuration::minutes(minutes as i64);
        self.sedentary_next = Some(next);
        db.set_setting(KEY_SEDENTARY_NEXT_AT, json!(ts(next)))?;
        Ok(())
    }
}

fn credit_segment(
    active: &mut ActiveSession,
    now: DateTime<Utc>,
    mono: Instant,
) -> CreditOutcome {
    let mono_delta = mono
        .saturating_duration_since(active.last_tick_mono)
        .as_millis() as i64;
    let wall_delta = active
        .rec
        .last_tick_at
        .map(|last| now.signed_duration_since(last).num_milliseconds())
        .unwrap_or(0);
    if wall_delta.abs() > CLOCK_JUMP_THRESHOLD_MS
        && (wall_delta - mono_delta).abs() > CLOCK_JUMP_THRESHOLD_MS
    {
        active.clock_jumps = active.clock_jumps.saturating_add(1);
    }
    active.rec.last_tick_at = Some(now);
    active.last_tick_mono = mono;
    if mono_delta <= 0 {
        return CreditOutcome::None;
    }
    if mono_delta >= UNCONFIRMED_GAP.as_millis() as i64 {
        return CreditOutcome::UncertainGap;
    }
    let remaining = (active.planned_ms() - active.rec.accumulated_ms).max(0);
    let credit = mono_delta.min(remaining);
    active.rec.accumulated_ms += credit;
    if credit > 0 {
        CreditOutcome::Credited(credit)
    } else {
        CreditOutcome::None
    }
}

fn pause_with_reason(active: &mut ActiveSession, now: DateTime<Utc>, reason: &str) {
    active.rec.state = SessionState::Paused;
    active.rec.paused_at = Some(now);
    active.rec.pause_reason = Some(reason.to_string());
    active.rec.running_since = None;
    active.running_since_mono = None;
}

fn flush_pending(
    conn: &rusqlite::Connection,
    pending: &HashMap<String, PendingDaily>,
    now: DateTime<Utc>,
) -> AppResult<()> {
    for (day, p) in pending {
        if p.focus_ms == 0 && p.break_ms == 0 && p.completed == 0 {
            continue;
        }
        store::upsert_daily(conn, day, p.focus_ms, p.break_ms, p.completed, now)?;
    }
    Ok(())
}

fn push_completion_notification(
    conn: &rusqlite::Connection,
    done: &CompletedInfo,
    now: DateTime<Utc>,
) -> AppResult<()> {
    let (title, body) = match done.kind {
        SessionKind::Focus => {
            let scope = if done.task_title.is_empty() {
                "专注".to_string()
            } else {
                done.task_title.clone()
            };
            (
                "专注完成".to_string(),
                format!(
                    "{} · 本轮 {} 分钟，建议休息 {} 分钟。",
                    scope, done.minutes, done.next_break_minutes
                ),
            )
        }
        SessionKind::ShortBreak | SessionKind::LongBreak => (
            "休息结束".to_string(),
            "休息结束，可以开始下一轮专注了。".to_string(),
        ),
    };
    store::insert_notification(
        conn,
        &format!("focus-{}", done.session_id),
        "focus",
        &title,
        &body,
        "focus",
        &done.session_id,
        &done.session_id,
        now,
    )
}

#[cfg(test)]
#[path = "core_tests.rs"]
mod tests;
