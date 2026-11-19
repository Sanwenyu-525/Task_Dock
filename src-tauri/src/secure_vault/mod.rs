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
use crate::secure_vault::session::{LockReason, RuntimeState, VaultSession};
use crate::secure_vault::store::VaultStore;

pub const DB_FILE: &str = "secure-vault.db";
pub const SESSION_MARKER: &str = "secure-vault.session.json";
pub const EVENT_LOCKED: &str = "vault-locked";
pub const EVENT_STATUS: &str = "vault-status";

pub struct VaultState {
    pub data_dir: PathBuf,
    pub app: AppHandle,
    pub session: RwLock<VaultSession>,
    pub store: Mutex<Option<VaultStore>>,
    pub unlock_gate: tokio::sync::Mutex<()>,
    pub write_gate: tokio::sync::Mutex<()>,
    pub startup_error: Mutex<Option<String>>,
    pub ticker: Mutex<Option<JoinHandle<()>>>,
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

    pub fn lock(&self, reason: LockReason) -> bool {
        let (was_unlocked, vault_id) = {
            let s = self.session.read();
            (s.is_unlocked(), s.vault_id.clone())
        };
        if !was_unlocked && vault_id.is_empty() {
            return false;
        }
        {
            let mut s = self.session.write();
            s.clear(reason);
        }
        let _ = std::fs::remove_file(self.data_dir.join(SESSION_MARKER));
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
