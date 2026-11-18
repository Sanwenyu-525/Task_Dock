//! 解锁会话：DEK、记录索引、锁定策略计时与一次性剪贴板待清除标记。
//!
//! 会话**只存在于内存**；锁定时 `clear()` 会 zeroize DEK 并丢弃索引。
//! 前端拿不到任何密钥材料。

use std::collections::HashMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeState {
    NoVault,
    Locked,
    Unlocked,
    Recovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LockReason {
    Manual,
    Idle,
    Background,
    SystemLock,
    Sleep,
    WindowHidden,
    Crash,
    FailLimit,
    MasterPasswordChanged,
}

impl LockReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Idle => "idle",
            Self::Background => "background",
            Self::SystemLock => "system_lock",
            Self::Sleep => "sleep",
            Self::WindowHidden => "window_hidden",
            Self::Crash => "crash",
            Self::FailLimit => "fail_limit",
            Self::MasterPasswordChanged => "master_password_changed",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockSettings {
    pub idle_secs: u64,
    pub background_secs: u64,
    pub clipboard_clear_secs: u64,
    pub reveal_secs: u64,
}

impl Default for LockSettings {
    fn default() -> Self {
        Self {
            idle_secs: 300,
            background_secs: 60,
            clipboard_clear_secs: 30,
            reveal_secs: 60,
        }
    }
}

impl LockSettings {
    pub fn validate(&self) -> Result<(), crate::secure_vault::error::VaultError> {
        use crate::secure_vault::error::VaultError;
        if !(0..=3600).contains(&self.idle_secs) {
            return Err(VaultError::validation("闲置锁定", "须在 0–3600 秒之间"));
        }
        if !(0..=3600).contains(&self.background_secs) {
            return Err(VaultError::validation("后台锁定", "须在 0–3600 秒之间"));
        }
        if !(5..=300).contains(&self.clipboard_clear_secs) {
            return Err(VaultError::validation("剪贴板清除", "须在 5–300 秒之间"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretField {
    pub id: String,
    pub label: String,
    /// password | text | multiline | date | number
    pub kind: String,
    /// utf8 | base64（私钥等按原始字节保存）
    #[serde(default = "default_encoding")]
    pub encoding: String,
    #[serde(default)]
    pub value: String,
}

fn default_encoding() -> String {
    "utf8".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordSecret {
    pub version: u32,
    pub fields: Vec<SecretField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordMeta {
    pub id: String,
    #[serde(default)]
    pub rev: i64,
    #[serde(default)]
    pub field_count: usize,
    #[serde(rename = "type")]
    pub record_type: String,
    pub title: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub category_id: String,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Default)]
pub struct VaultIndex {
    pub rows: Vec<RecordMeta>,
    pub by_id: HashMap<String, usize>,
    /// 最近使用时间（ISO-8601）。
    pub usage: HashMap<String, String>,
    /// 解密后的标签名，用于列表筛选。
    pub tag_names: HashMap<String, String>,
    pub category_names: HashMap<String, String>,
}

impl VaultIndex {
    pub fn rebuild(&mut self, rows: Vec<RecordMeta>) {
        self.rows = rows;
        self.by_id = self
            .rows
            .iter()
            .enumerate()
            .map(|(i, r)| (r.id.clone(), i))
            .collect();
    }

    pub fn insert(&mut self, meta: RecordMeta) {
        if let Some(i) = self.by_id.get(&meta.id).copied() {
            self.rows[i] = meta;
        } else {
            self.by_id.insert(meta.id.clone(), self.rows.len());
            self.rows.push(meta);
        }
    }

    pub fn remove(&mut self, id: &str) {
        if let Some(i) = self.by_id.remove(id) {
            self.rows.remove(i);
            self.by_id = self
                .rows
                .iter()
                .enumerate()
                .map(|(idx, r)| (r.id.clone(), idx))
                .collect();
        }
        self.usage.remove(id);
    }
}

#[derive(Debug, Clone)]
pub struct PendingCopy {
    pub token: String,
    pub record_id: String,
    pub field_id: String,
    pub digest: [u8; 32],
    pub expires: Instant,
    pub clear_after_secs: u64,
}

pub struct VaultSession {
    pub runtime: RuntimeState,
    pub dek: Option<Zeroizing<[u8; 32]>>,
    pub dek_ver: u32,
    pub vault_id: String,
    pub vault_salt: [u8; 16],
    pub index: VaultIndex,
    pub lock_settings: LockSettings,
    pub last_activity: Instant,
    pub background_since: Option<Instant>,
    pub pending_copy: Option<PendingCopy>,
    pub last_lock_reason: Option<LockReason>,
    pub fail_count: u32,
}

impl Default for VaultSession {
    fn default() -> Self {
        Self {
            runtime: RuntimeState::NoVault,
            dek: None,
            dek_ver: 1,
            vault_id: String::new(),
            vault_salt: [0u8; 16],
            index: VaultIndex::default(),
            lock_settings: LockSettings::default(),
            last_activity: Instant::now(),
            background_since: None,
            pending_copy: None,
            last_lock_reason: None,
            fail_count: 0,
        }
    }
}

impl VaultSession {
    pub fn is_unlocked(&self) -> bool {
        self.runtime == RuntimeState::Unlocked
    }

    pub fn dek_copy(&self) -> Option<Zeroizing<[u8; 32]>> {
        self.dek.as_ref().map(|d| {
            let mut out = [0u8; 32];
            out.copy_from_slice(&d[..]);
            Zeroizing::new(out)
        })
    }

    pub fn touch(&mut self) {
        self.last_activity = Instant::now();
    }

    /// 锁定：丢弃 DEK、索引与剪贴板待清除标记。
    pub fn clear(&mut self, reason: LockReason) {
        self.dek = None;
        self.index = VaultIndex::default();
        self.pending_copy = None;
        self.background_since = None;
        self.last_lock_reason = Some(reason);
        self.runtime = if self.runtime == RuntimeState::NoVault {
            RuntimeState::NoVault
        } else {
            RuntimeState::Locked
        };
        self.vault_id.clear();
        self.vault_salt = [0u8; 16];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_drops_dek_and_index() {
        let mut s = VaultSession::default();
        s.runtime = RuntimeState::Unlocked;
        s.dek = Some(Zeroizing::new([9u8; 32]));
        s.index.rebuild(vec![RecordMeta {
            id: "r1".into(),
            rev: 1,
            field_count: 0,
            record_type: "password".into(),
            title: "t".into(),
            username: String::new(),
            email: String::new(),
            url: String::new(),
            platform: String::new(),
            category_id: String::new(),
            tag_ids: vec![],
            favorite: false,
            note: String::new(),
            created_at: "now".into(),
            updated_at: "now".into(),
        }]);
        s.clear(LockReason::Manual);
        assert!(s.dek.is_none());
        assert!(s.index.rows.is_empty());
        assert_eq!(s.runtime, RuntimeState::Locked);
        assert_eq!(s.last_lock_reason, Some(LockReason::Manual));
    }
}
