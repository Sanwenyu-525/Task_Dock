//! 专注与休息（番茄钟 + 久坐提醒）。
//!
//! 本模块刻意**不新建第二套常驻 1 秒调度**：`tick` 由现有 `scheduler.rs` 的 1 秒循环调用；
//! 前端倒计时复用 `src/lib/sharedClock.ts` 的共享时钟。通知复用 `AgentHub` 的提醒通道。
//!
//! 并行开发约定：本模块由集成会话在 `lib.rs` 注册 `pub mod focus;` 并在调度循环中调用
//! `focus::tick(&app, &db, &hub)`；数据库迁移与命令注册见
//! `tmp/acceptance/focus-and-break/integration.md`。

pub mod core;
pub mod model;
pub mod store;

use std::sync::Mutex;
use std::time::Instant;

use chrono::{DateTime, Utc};
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::agents::notify::NotifyItem;
use crate::agents::AgentHub;
use crate::db::Db;
use crate::error::AppResult;

pub use core::{CompletedInfo, FocusCore, TickEffects};
pub use model::{
    FocusHistoryItem, FocusPrefs, FocusPrefsPatch, FocusSessionView, FocusSnapshot, SessionKind,
    SessionState, TodayStats,
};

/// 进程内唯一状态。命令与调度器共用同一把锁，避免并发创建多个会话。
static RUNTIME: Mutex<Option<FocusCore>> = Mutex::new(None);

fn with_core<T>(
    db: &Db,
    now: DateTime<Utc>,
    mono: Instant,
    f: impl FnOnce(&mut FocusCore) -> AppResult<T>,
) -> AppResult<T> {
    let mut guard = RUNTIME.lock().unwrap_or_else(|e| e.into_inner());
    let core = guard.get_or_insert_with(FocusCore::new);
    core.ensure_loaded(db, now, mono)?;
    f(core)
}

/// 数据导入/备份恢复成功后丢弃进程内缓存。
///
/// 导入会在**同一进程内**整体替换用户表；`RUNTIME` 缓存的偏好、轮次计数与活跃会话
/// 都来自旧库。继续使用会写回旧值，或让界面显示新库中已不存在的会话。清空后下一次
/// 命令/调度 tick 会按新库重新 `ensure_loaded`（未完成会话按「应用重启」转为暂停，
/// 不补记区间）。只清内存，不写库。
pub fn reset_runtime() {
    let mut guard = RUNTIME.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

/// 启动时恢复上次会话（转暂停，不补记退出区间）。由 `lib.rs` 在 setup 中调用。
pub fn restore_on_startup(db: &Db) -> AppResult<()> {
    let now = Utc::now();
    let mono = Instant::now();
    with_core(db, now, mono, |_| Ok(()))
}

pub fn snapshot(db: &Db) -> AppResult<FocusSnapshot> {
    let now = Utc::now();
    let mono = Instant::now();
    with_core(db, now, mono, |core| core.snapshot(db, now, mono))
}

pub fn history(db: &Db, limit: u32) -> AppResult<Vec<FocusHistoryItem>> {
    store::list_history(db, limit)
}

fn mutate<T>(
    app: &AppHandle,
    db: &Db,
    f: impl FnOnce(&mut FocusCore, DateTime<Utc>, Instant) -> AppResult<T>,
) -> AppResult<T> {
    let now = Utc::now();
    let mono = Instant::now();
    let out = with_core(db, now, mono, |core| f(core, now, mono))?;
    let _ = app.emit("focus-changed", ());
    Ok(out)
}

pub fn start(
    app: &AppHandle,
    db: &Db,
    task_id: Option<String>,
) -> AppResult<FocusSnapshot> {
    mutate(app, db, |core, now, mono| {
        core.start_focus(db, task_id, now, mono)?;
        core.snapshot(db, now, mono)
    })
}

pub fn start_break(app: &AppHandle, db: &Db) -> AppResult<FocusSnapshot> {
    mutate(app, db, |core, now, mono| {
        core.start_break(db, now, mono)?;
        core.snapshot(db, now, mono)
    })
}

pub fn pause(app: &AppHandle, db: &Db) -> AppResult<FocusSnapshot> {
    mutate(app, db, |core, now, mono| {
        core.pause(db, now, mono)?;
        core.snapshot(db, now, mono)
    })
}

pub fn resume(app: &AppHandle, db: &Db) -> AppResult<FocusSnapshot> {
    mutate(app, db, |core, now, mono| {
        core.resume(db, now, mono)?;
        core.snapshot(db, now, mono)
    })
}

pub fn finish(app: &AppHandle, db: &Db) -> AppResult<FocusSnapshot> {
    mutate(app, db, |core, now, mono| {
        core.finish(db, now, mono)?;
        core.snapshot(db, now, mono)
    })
}

pub fn cancel(app: &AppHandle, db: &Db) -> AppResult<FocusSnapshot> {
    mutate(app, db, |core, now, mono| {
        core.cancel(db, now, mono)?;
        core.snapshot(db, now, mono)
    })
}

pub fn extend_break(
    app: &AppHandle,
    db: &Db,
    minutes: u32,
) -> AppResult<FocusSnapshot> {
    mutate(app, db, |core, now, mono| {
        core.extend_break(db, minutes, now)?;
        core.snapshot(db, now, mono)
    })
}

pub fn skip_break(app: &AppHandle, db: &Db) -> AppResult<FocusSnapshot> {
    mutate(app, db, |core, now, mono| {
        core.skip_break(db, now, mono)?;
        core.snapshot(db, now, mono)
    })
}

pub fn update_prefs(
    app: &AppHandle,
    db: &Db,
    patch: FocusPrefsPatch,
) -> AppResult<FocusPrefs> {
    mutate(app, db, |core, now, _mono| core.update_prefs(db, patch, now))
}

pub fn snooze_sedentary(
    app: &AppHandle,
    db: &Db,
    minutes: u32,
) -> AppResult<FocusSnapshot> {
    mutate(app, db, |core, now, mono| {
        core.snooze_sedentary(db, minutes, now)?;
        core.snapshot(db, now, mono)
    })
}

fn completion_text(done: &CompletedInfo) -> (String, String) {
    match done.kind {
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
    }
}

/// 由 `scheduler.rs` 每秒调用。副作用（通知/事件）放在锁外执行，避免阻塞状态推进。
pub fn tick(app: &AppHandle, db: &Db, hub: &AgentHub) {
    let now = Utc::now();
    let mono = Instant::now();
    let effects = match with_core(db, now, mono, |core| core.tick(db, now, mono)) {
        Ok(effects) => effects,
        Err(err) => {
            tracing::warn!("专注调度 tick 失败: {}", err);
            return;
        }
    };

    if effects.changed {
        let _ = app.emit("focus-changed", ());
    }
    if let Some(done) = effects.completed.as_ref() {
        let (title, body) = completion_text(done);
        hub.notify_reminder_popups(&[NotifyItem::new("reminder", &title, &body)]);
        let _ = app.emit(
            "focus-completed",
            json!({
                "session_id": done.session_id,
                "kind": done.kind,
                "minutes": done.minutes,
                "task_title": done.task_title,
                "round_index": done.round_index,
            }),
        );
    }
    if effects.sedentary_due {
        let _ = app.emit("focus-sedentary", ());
        hub.notify_reminder_popups(&[NotifyItem::new(
            "reminder",
            "久坐提醒",
            "起身活动一下，短暂休息后再继续。",
        )]);
    }
}
