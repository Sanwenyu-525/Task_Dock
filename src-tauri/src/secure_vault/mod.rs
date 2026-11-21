//! 安全保险箱后端入口：状态、独立库句柄、锁定 ticker。

pub mod backup;
pub mod commands;
pub mod crypto;
pub mod error;
pub mod policy;
pub mod session;
pub mod store;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};

use crate::secure_vault::error::VaultError;
use crate::secure_vault::session::{LockReason, RuntimeState, ScrubTicket, VaultSession};
use crate::secure_vault::store::VaultStore;

pub const DB_FILE: &str = "secure-vault.db";
pub const SESSION_MARKER: &str = "secure-vault.session.json";
pub const EVENT_LOCKED: &str = "vault-locked";
pub const EVENT_STATUS: &str = "vault-status";

/// 锁定后清理系统剪贴板的预算：超出即停止重试并如实记审计，绝不无限等待。
///
/// 真实剪贴板可能被其他程序长期占用（`OpenClipboard` 会失败），所以清理必须是
/// 「先同步试一次、失败后在预算内退避重试」，而不是在锁定路径上死等。
pub const SCRUB_BUDGET: Duration = Duration::from_secs(5);
/// 重试间隔（毫秒）。总和 4.32s，落在 `SCRUB_BUDGET` 内。
const SCRUB_BACKOFF_MS: &[u64] = &[120, 300, 700, 1200, 2000];

/// 单次清理尝试的判定：只有 `Busy` 值得重试。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScrubAttempt {
    Done,
    Retry,
}

pub struct VaultState {
    pub data_dir: PathBuf,
    pub app: AppHandle,
    pub session: RwLock<VaultSession>,
    pub store: Mutex<Option<VaultStore>>,
    pub unlock_gate: tokio::sync::Mutex<()>,
    pub write_gate: tokio::sync::Mutex<()>,
    pub startup_error: Mutex<Option<String>>,
    pub ticker: Mutex<Option<JoinHandle<()>>>,
    /// 锁定后仍需清理的剪贴板指纹。独立于 `session`：会话已清空，票据必须活着。
    pub scrub: Mutex<Option<ScrubTicket>>,
}

impl VaultState {
    pub fn new(app: AppHandle, data_dir: PathBuf) -> Arc<Self> {
        let path = data_dir.join(DB_FILE);
        let mut startup_error = None;
        let store = if path.exists() {
            match VaultStore::open(&path) {
                Ok(s) => Some(s),
                Err(e) => {
                    startup_error = Some(e.message.clone());
                    None
                }
            }
        } else {
            None
        };
        let mut session = VaultSession::default();
        session.runtime = match store.as_ref() {
            Some(s) => match s.is_initialized() {
                Ok(true) => RuntimeState::Locked,
                Ok(false) => RuntimeState::NoVault,
                Err(e) => {
                    startup_error = Some(e.message.clone());
                    RuntimeState::Locked
                }
            },
            None => RuntimeState::NoVault,
        };
        // 解锁期间写下的 session marker 说明上次进程未走正常锁定流程：
        // 记录 crash 原因并删除 marker，避免下次启动重复提示。
        let marker = data_dir.join(SESSION_MARKER);
        if marker.exists() {
            let _ = std::fs::remove_file(&marker);
            if session.runtime == RuntimeState::Locked {
                session.last_lock_reason = Some(LockReason::Crash);
            }
        }
        let state = Arc::new(Self {
            data_dir,
            app,
            session: RwLock::new(session),
            store: Mutex::new(store),
            unlock_gate: tokio::sync::Mutex::new(()),
            write_gate: tokio::sync::Mutex::new(()),
            startup_error: Mutex::new(startup_error),
            ticker: Mutex::new(None),
            scrub: Mutex::new(None),
        });
        Self::spawn_ticker(&state);
        state
    }

    pub fn store_path(&self) -> PathBuf {
        self.data_dir.join(DB_FILE)
    }

    pub fn has_vault(&self) -> bool {
        self.store
            .lock()
            .as_ref()
            .and_then(|s| s.is_initialized().ok())
            .unwrap_or(false)
    }

    pub fn with_store<T>(
        &self,
        f: impl FnOnce(&VaultStore) -> Result<T, VaultError>,
    ) -> Result<T, VaultError> {
        let guard = self.store.lock();
        let store = guard
            .as_ref()
            .ok_or_else(|| VaultError::internal("store:unavailable"))?;
        f(store)
    }

    pub fn insert_store(&self, store: VaultStore) {
        *self.store.lock() = Some(store);
    }

    pub fn note_activity(&self) {
        let mut s = self.session.write();
        s.touch();
    }

    pub fn on_background(&self, background: bool) {
        let mut s = self.session.write();
        if !s.is_unlocked() {
            return;
        }
        if background {
            if s.background_since.is_none() {
                s.background_since = Some(Instant::now());
            }
        } else {
            s.background_since = None;
            s.touch();
        }
    }

    /// 唯一锁定入口：所有锁定原因（手动 / 空闲 / 后台 / 锁屏 / 休眠 / 窗口隐藏）都走这里。
    ///
    /// 顺序是强制的：
    /// 1. **同一把写锁内**取出待清除的剪贴板指纹、推进会话世代、清空会话；
    /// 2. 会话清空后，指纹票据搬到独立槽位（`scrub`），不随会话销毁；
    /// 3. 先同步尝试一次（非阻塞），忙则后台在 `SCRUB_BUDGET` 内退避重试。
    ///
    /// 为什么第 1 步必须原子：若先读 `pending_copy`、再单独取写锁清空，二者之间
    /// `vault_copy_secret` 可以把新票据登记进来，随即被 `clear()` 丢弃——密码就留在
    /// 系统剪贴板上且没有任何人再管它（旧实现正是这个行为）。
    pub fn lock(self: &Arc<Self>, reason: LockReason) -> bool {
        let pending = {
            let mut s = self.session.write();
            match s.lock_now(reason) {
                crate::secure_vault::session::LockTransition::Ignored => return false,
                crate::secure_vault::session::LockTransition::Locked { pending } => pending,
            }
        };
        let _ = std::fs::remove_file(self.data_dir.join(SESSION_MARKER));
        if let Some(pending) = pending {
            let ticket = ScrubTicket {
                digest: pending.digest,
                deadline: Instant::now() + SCRUB_BUDGET,
                attempts: 0,
            };
            match self.try_scrub_once(&ticket) {
                ScrubAttempt::Done => {
                    *self.scrub.lock() = None;
                }
                ScrubAttempt::Retry => {
                    *self.scrub.lock() = Some(ticket.clone());
                    Self::spawn_scrub_retry(self.clone(), ticket);
                }
            }
        }
        let _ = self.app.emit(
            EVENT_LOCKED,
            serde_json::json!({
                "reason": reason.code(),
                "at": chrono::Utc::now().to_rfc3339(),
            }),
        );
        let _ = self.app.emit(EVENT_STATUS, self.status_payload());
        true
    }

    /// 单次清理尝试。只有「剪贴板忙」才值得重试；指纹不一致说明用户已复制新内容，
    /// 必须原样保留并结束本次清理。
    fn try_scrub_once(&self, ticket: &ScrubTicket) -> ScrubAttempt {
        let Some(runtime) = crate::secure_vault::commands::clipboard_runtime(&self.app) else {
            // 剪贴板模块未启用：没有本进程写入的剪贴板内容可清，按已处理结束。
            return ScrubAttempt::Done;
        };
        use crate::clipboard::platform::{try_scrub_text_if_digest, ScrubOutcome};
        match try_scrub_text_if_digest(&ticket.digest, &runtime.self_write) {
            ScrubOutcome::Cleared => {
                let _ = self.with_store(|s| s.audit("clipboard_clear", "ok", Some("lock_scrub"), None));
                ScrubAttempt::Done
            }
            ScrubOutcome::NothingToClear => ScrubAttempt::Done,
            ScrubOutcome::ContentChanged => {
                let _ = self.with_store(|s| {
                    s.audit("clipboard_clear", "skipped", Some("changed_by_user"), None)
                });
                ScrubAttempt::Done
            }
            ScrubOutcome::Unavailable => {
                let _ = self.with_store(|s| {
                    s.audit("clipboard_clear", "failed", Some("write_failed"), None)
                });
                ScrubAttempt::Done
            }
            ScrubOutcome::Busy => ScrubAttempt::Retry,
        }
    }

    /// 预算内退避重试。票据被新的锁定替换时立即退出（新票据由新任务负责）。
    pub(crate) fn spawn_scrub_retry(state: Arc<Self>, ticket: ScrubTicket) {
        tauri::async_runtime::spawn(async move {
            for (index, delay) in SCRUB_BACKOFF_MS.iter().enumerate() {
                tokio::time::sleep(Duration::from_millis(*delay)).await;
                if Instant::now() >= ticket.deadline {
                    break;
                }
                let still_mine = state
                    .scrub
                    .lock()
                    .as_ref()
                    .is_some_and(|t| t.digest == ticket.digest && t.deadline == ticket.deadline);
                if !still_mine {
                    return;
                }
                match state.try_scrub_once(&ticket) {
                    ScrubAttempt::Done => {
                        *state.scrub.lock() = None;
                        return;
                    }
                    ScrubAttempt::Retry => {
                        if let Some(slot) = state.scrub.lock().as_mut() {
                            slot.attempts = (index + 1) as u8;
                        }
                    }
                }
            }
            let mut slot = state.scrub.lock();
            if slot
                .as_ref()
                .is_some_and(|t| t.digest == ticket.digest && t.deadline == ticket.deadline)
            {
                *slot = None;
                drop(slot);
                // 预算耗尽：如实记「剪贴板一直忙」，不假装已清除。
                let _ = state.with_store(|s| {
                    s.audit("clipboard_clear", "failed", Some("clipboard_busy"), None)
                });
            }
        });
    }

    pub fn status_payload(&self) -> serde_json::Value {
        let s = self.session.read();
        serde_json::json!({
            "state": s.runtime,
            "unlocked": s.runtime == RuntimeState::Unlocked,
            "hasVault": self.has_vault(),
            "lastLockReason": s.last_lock_reason.map(|r| r.code()),
            "startupError": self.startup_error.lock().clone(),
        })
    }

    fn spawn_ticker(state: &Arc<Self>) {
        let weak = Arc::downgrade(state);
        let handle = tauri::async_runtime::spawn(async move {
            let mut last_wall = std::time::SystemTime::now();
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let Some(state) = weak.upgrade() else {
                    break;
                };
                let now_wall = std::time::SystemTime::now();
                let gap = now_wall.duration_since(last_wall).unwrap_or_default();
                last_wall = now_wall;
                // 系统休眠会暂停线程：正常 tick 间隔 2s，出现明显墙钟跳跃时按
                // 休眠恢复处理，立即锁定；这也覆盖部分不投递 WM_POWERBROADCAST 的场景。
                if gap > Duration::from_secs(10) && state.session.read().is_unlocked() {
                    state.lock(LockReason::Sleep);
                }
                // WTS 会话锁屏：轮询 WTSSessionInfoEx 的 SessionFlags。
                // 锁屏后输入桌面切换，2 秒内必定触发；前端计时器不参与该判断。
                if session_locked() && state.session.read().is_unlocked() {
                    state.lock(LockReason::SystemLock);
                }
                let reason = {
                    let s = state.session.read();
                    policy::should_lock_now(&s, Instant::now())
                };
                if let Some(reason) = reason {
                    state.lock(reason);
                }
            }
        });
        *state.ticker.lock() = Some(handle);
    }
}

/// 当前 Windows 会话是否处于锁屏（WTSSessionInfoEx.SessionFlags == LOCK）。
/// 非 Windows 恒为 false；查询失败按“未锁定”处理，避免误锁。
#[cfg(windows)]
fn session_locked() -> bool {
    use std::ptr::null_mut;
    use windows_sys::Win32::System::RemoteDesktop::{
        WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
        WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK,
    };

    let mut buffer: *mut u16 = null_mut();
    let mut bytes = 0u32;
    let ok = unsafe {
        WTSQuerySessionInformationW(
            null_mut(),
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut bytes,
        )
    };
    if ok == 0 || buffer.is_null() || bytes == 0 {
        return false;
    }
    let info = unsafe { &*(buffer as *const WTSINFOEXW) };
    let locked = if info.Level == 1 {
        let flags = unsafe { info.Data.WTSInfoExLevel1.SessionFlags };
        flags == WTS_SESSIONSTATE_LOCK as i32
    } else {
        false
    };
    unsafe { WTSFreeMemory(buffer as *mut _) };
    locked
}

#[cfg(not(windows))]
fn session_locked() -> bool {
    false
}

pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DB_FILE)
}
