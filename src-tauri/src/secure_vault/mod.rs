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
use tauri::{AppHandle, Emitter};
use tauri::async_runtime::JoinHandle;

use crate::secure_vault::error::VaultError;
use crate::secure_vault::session::{LockReason, RuntimeState, VaultSession};
use crate::secure_vault::store::VaultStore;

pub const DB_FILE: &str = "secure-vault.db";
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
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let Some(state) = weak.upgrade() else {
                    break;
                };
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

pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DB_FILE)
}
