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
            reveal_secs: 30,
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
        if !(5..=300).contains(&self.reveal_secs) {
            return Err(VaultError::validation("敏感字段显示", "须在 5–300 秒之间"));
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
    /// 字段明文。用 `Zeroizing<String>` 而不是裸 `String`：
    /// 解密后的整条记录（含未被揭示的字段）在离开作用域时自动清零，
    /// 避免「取一条记录、只显示一个字段」把其余明文长期留在堆上。
    /// 这不等于能清除前端 JS 堆、操作系统或其它进程已持有的副本。
    #[serde(default, with = "zeroizing_string")]
    pub value: Zeroizing<String>,
}

/// `Zeroizing<String>` 的 serde 适配：JSON 契约仍是普通字符串。
///
/// `zeroize` 1.9 没有 serde feature，手写四行比引入新依赖更可控。
mod zeroizing_string {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use zeroize::Zeroizing;

    pub fn serialize<S: Serializer>(value: &Zeroizing<String>, ser: S) -> Result<S::Ok, S::Error> {
        value.as_str().serialize(ser)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Zeroizing<String>, D::Error> {
        String::deserialize(de).map(Zeroizing::new)
    }
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

/// 锁定后的剪贴板清理票据。
///
/// 必须独立于 `VaultSession`：`clear()` 会丢弃会话里的一切，但系统剪贴板上的
/// 明文只能靠这份指纹判断「是否仍是我们写的那份」，票据跟着会话一起消失，
/// 就等于把密码永久留在剪贴板上。
#[derive(Debug, Clone)]
pub struct ScrubTicket {
    pub digest: [u8; 32],
    /// 重试截止时间（墙钟无关，纯进程内计时）。
    pub deadline: Instant,
    pub attempts: u8,
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
    /// 会话世代：解锁与锁定各自递增。
    ///
    /// 用途是让「检查通过之后才发生的锁定」能被发现：在飞请求在返回明文/写剪贴板前
    /// 比对快照世代，失配即丢弃结果。没有它，`require_unlocked()` 只能证明入口那一刻
    /// 是解锁的。
    pub generation: u64,
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
            generation: 0,
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

    /// 锁定的原子步骤：取出待清除的剪贴板票据、推进世代、清空会话。
    ///
    /// 三件事必须在**同一把写锁内**完成：
    /// - 只取 pending 不清空 → 读取线程仍能用旧 DEK 解密；
    /// - 只清空不取 pending → 票据随会话消失，剪贴板上的密码再没人处理；
    /// - 不推进世代 → 在飞请求无法判断「我拿到的 DEK 已经作废」。
    pub fn lock_now(&mut self, reason: LockReason) -> LockTransition {
        if !self.is_unlocked() && self.vault_id.is_empty() {
            return LockTransition::Ignored;
        }
        let pending = self.pending_copy.take();
        self.generation = self.generation.wrapping_add(1);
        self.clear(reason);
        LockTransition::Locked { pending }
    }
}

/// `lock_now` 的结果：区分「本来就锁着」与「真的锁了一次」。
#[derive(Debug)]
pub enum LockTransition {
    /// 未解锁且没有库：调用方不应广播事件或做清理。
    Ignored,
    Locked {
        /// 仍在剪贴板上、需要按指纹清理的票据（若有）。
        pending: Option<PendingCopy>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_settings_secure_defaults() {
        let settings = LockSettings::default();
        assert_eq!(settings.idle_secs, 300);
        assert_eq!(settings.background_secs, 60);
        assert_eq!(settings.clipboard_clear_secs, 30);
        assert_eq!(settings.reveal_secs, 30);
        assert!(settings.validate().is_ok());

        let mut invalid = settings;
        invalid.reveal_secs = 0;
        assert!(invalid.validate().is_err());
    }

    fn copy_pending() -> PendingCopy {
        PendingCopy {
            token: "t-1".into(),
            record_id: "r1".into(),
            field_id: "password".into(),
            digest: [7u8; 32],
            expires: Instant::now() + std::time::Duration::from_secs(30),
            clear_after_secs: 30,
        }
    }

    /// T-CLP-04 的前置条件：锁定时必须把剪贴板票据**交出来**，而不是随会话丢弃。
    #[test]
    fn lock_now_hands_out_pending_copy_before_clearing() {
        let mut s = VaultSession::default();
        s.runtime = RuntimeState::Unlocked;
        s.dek = Some(Zeroizing::new([1u8; 32]));
        s.vault_id = "vault-1".into();
        s.pending_copy = Some(copy_pending());
        let generation = s.generation;

        let transition = s.lock_now(LockReason::Manual);
        match transition {
            LockTransition::Locked { pending } => {
                let pending = pending.expect("锁定时必须交出待清除票据");
                assert_eq!(pending.token, "t-1");
                assert_eq!(pending.digest, [7u8; 32]);
            }
            LockTransition::Ignored => panic!("解锁中的会话必须真正锁定"),
        }
        assert!(s.dek.is_none());
        assert!(s.pending_copy.is_none(), "会话里不能再留着票据");
        assert_eq!(s.generation, generation.wrapping_add(1));
        assert_eq!(s.runtime, RuntimeState::Locked);
    }

    /// 未解锁且没有库：视为无效锁定，不得推进世代（否则会误伤在飞请求的判定）。
    #[test]
    fn lock_now_ignores_already_locked_session_without_vault() {
        let mut s = VaultSession::default();
        let generation = s.generation;
        assert!(matches!(s.lock_now(LockReason::Idle), LockTransition::Ignored));
        assert_eq!(s.generation, generation);
    }

    /// 字段明文用 `Zeroizing<String>`：JSON 契约必须仍是普通字符串，旧数据可直接反序列化。
    #[test]
    fn secret_field_json_contract_is_unchanged() {
        let field = SecretField {
            id: "password".into(),
            label: "密码".into(),
            kind: "password".into(),
            encoding: "utf8".into(),
            value: Zeroizing::new("s3cret".to_string()),
        };
        let json = serde_json::to_value(&field).unwrap();
        assert_eq!(json["value"], serde_json::json!("s3cret"));
        let back: SecretField = serde_json::from_value(json).unwrap();
        assert_eq!(back.value.as_str(), "s3cret");
    }

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
