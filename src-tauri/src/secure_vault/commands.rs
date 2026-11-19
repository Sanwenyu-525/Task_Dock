//! 保险箱 IPC 命令。只做参数校验、会话门禁、调用 crypto/store、组装 DTO。
//!
//! **禁止**在此模块记录任何秘密、主密码、恢复密钥、字段值或搜索词到日志。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::clipboard::platform::{self, ClipboardPayload, WriteGuard, WriteOutcome};
use crate::clipboard::ClipboardRuntime;
use crate::secure_vault::crypto::aead;
use crate::secure_vault::crypto::envelope::{self, Envelope, KdfInfo};
use crate::secure_vault::crypto::kdf::{self, Argon2Params};
use crate::secure_vault::crypto::password_gen;
use crate::secure_vault::crypto::secret_bytes;
use crate::secure_vault::crypto::{random_array, record_aad, sha256};
use crate::secure_vault::error::VaultError;
use crate::secure_vault::session::{
    LockReason, LockSettings, PendingCopy, RecordMeta, RecordSecret, RuntimeState, SecretField,
    VaultIndex,
};
use crate::secure_vault::store::{
    decode_salt, Bootstrap, StoredName, StoredRecord, StoredUsage, VaultStore,
};
use crate::secure_vault::VaultState;

const DATA_VERSION: u32 = 1;
const ALG_VERSION: u32 = 1;
const DELETE_CONFIRM: &str = "DELETE VAULT";

// ── DTO ───────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatusDto {
    pub state: RuntimeState,
    pub has_vault: bool,
    pub unlocked: bool,
    pub recovery_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock: Option<LockSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_lock_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVaultDto {
    pub vault_id: String,
    pub recovery_code: String,
    pub recovery_groups: Vec<String>,
    pub kdf: KdfInfo,
    pub created_at: String,
    pub unlocked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockDto {
    pub state: RuntimeState,
    pub used_slot: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockCredential {
    /// password | recovery
    pub kind: String,
    pub value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordListItem {
    pub id: String,
    pub rev: i64,
    #[serde(rename = "type")]
    pub record_type: String,
    pub title: String,
    pub username: String,
    pub email: String,
    pub url: String,
    pub platform: String,
    pub category_id: String,
    pub category_name: String,
    pub tag_ids: Vec<String>,
    pub tag_names: Vec<String>,
    pub favorite: bool,
    pub updated_at: String,
    pub last_used_at: Option<String>,
    pub field_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordFieldView {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub revealed: bool,
    pub value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordDetailDto {
    pub id: String,
    pub rev: i64,
    #[serde(rename = "type")]
    pub record_type: String,
    pub title: String,
    pub username: String,
    pub email: String,
    pub url: String,
    pub platform: String,
    pub category_id: String,
    pub category_name: String,
    pub tag_ids: Vec<String>,
    pub tag_names: Vec<String>,
    pub favorite: bool,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
    pub fields: Vec<RecordFieldView>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordDraft {
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
    #[serde(default)]
    pub fields: Vec<SecretField>,
}

#[derive(Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordPatch {
    pub title: Option<String>,
    pub username: Option<String>,
    pub email: Option<String>,
    pub url: Option<String>,
    pub platform: Option<String>,
    pub category_id: Option<String>,
    pub tag_ids: Option<Vec<String>>,
    pub favorite: Option<bool>,
    pub note: Option<String>,
    pub fields: Option<Vec<SecretField>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdRevDto {
    pub id: String,
    pub rev: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryDto {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCategoryDto {
    pub affected_records: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyReceiptDto {
    pub cleared_after_secs: u64,
    pub token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearResultDto {
    pub cleared: bool,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventDto {
    pub id: i64,
    pub at: String,
    pub event: String,
    pub outcome: String,
    pub reason_code: Option<String>,
    pub count: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummaryDto {
    pub path: String,
    pub size: u64,
    pub record_count: usize,
    pub sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInspectDto {
    pub path: String,
    pub version: u32,
    pub vault_id: String,
    pub created_at: String,
    pub mode: String,
    pub record_count: usize,
    pub payload_len: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResultDto {
    pub imported: usize,
    pub skipped: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageData {
    last_used_at: String,
    use_count: i64,
}

// ── 小工具 ───────────────────────────────────────────────────

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn require_unlocked(state: &VaultState) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let s = state.session.read();
    if s.runtime == RuntimeState::Recovery && s.dek.is_some() {
        return s.dek_copy().ok_or_else(VaultError::locked);
    }
    if s.runtime != RuntimeState::Unlocked {
        return Err(VaultError::locked());
    }
    s.dek_copy().ok_or_else(VaultError::locked)
}

fn require_writable(state: &VaultState) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let s = state.session.read();
    if s.runtime == RuntimeState::Recovery {
        return Err(VaultError::recovery_readonly());
    }
    if s.runtime != RuntimeState::Unlocked {
        return Err(VaultError::locked());
    }
    s.dek_copy().ok_or_else(VaultError::locked)
}

fn session_salt(state: &VaultState) -> Result<[u8; 16], VaultError> {
    let s = state.session.read();
    if s.runtime != RuntimeState::Unlocked && s.runtime != RuntimeState::Recovery {
        return Err(VaultError::locked());
    }
    Ok(s.vault_salt)
}

fn validate_master_password(password: &str) -> Result<(), VaultError> {
    let normalized = kdf::normalize_password(password);
    let len = normalized.chars().count();
    if !(8..=128).contains(&len) {
        return Err(VaultError::validation("主密码", "长度须在 8–128 字符之间"));
    }
    let first = normalized.chars().next().unwrap_or(' ');
    if normalized.chars().all(|c| c == first) {
        return Err(VaultError::validation("主密码", "不能全部为同一字符"));
    }
    let lower = normalized.to_ascii_lowercase();
    if lower == "password" || lower == "12345678" || lower == "qwertyui" {
        return Err(VaultError::validation("主密码", "过于常见"));
    }
    Ok(())
}

fn validate_draft(draft: &RecordDraft) -> Result<(), VaultError> {
    let types = [
        "password", "api_key", "license", "recovery", "memo", "device", "ssh",
    ];
    if !types.contains(&draft.record_type.as_str()) {
        return Err(VaultError::validation("记录类型", "未知类型"));
    }
    let title = draft.title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(VaultError::validation("标题", "须为 1–200 字符"));
    }
    if draft.note.chars().count() > 4000 {
        return Err(VaultError::validation("备注", "不能超过 4000 字符"));
    }
    if draft.tag_ids.len() > 20 {
        return Err(VaultError::validation("标签", "单条记录最多 20 个"));
    }
    validate_fields(&draft.fields)
}

fn validate_fields(fields: &[SecretField]) -> Result<(), VaultError> {
    if fields.len() > 40 {
        return Err(VaultError::validation("字段", "单条记录最多 40 个字段"));
    }
    for f in fields {
        if f.label.trim().is_empty() || f.label.chars().count() > 80 {
            return Err(VaultError::validation("字段名", "须为 1–80 字符"));
        }
        if !["password", "text", "multiline", "date", "number"].contains(&f.kind.as_str()) {
            return Err(VaultError::validation("字段类型", "未知类型"));
        }
        if f.encoding != "utf8" && f.encoding != "base64" {
            return Err(VaultError::validation("字段编码", "只支持 utf8/base64"));
        }
        let limit = if f.encoding == "base64" {
            256 * 1024
        } else {
            64 * 1024
        };
        if f.value.len() > limit {
            return Err(VaultError::validation("字段值", "超出长度上限"));
        }
    }
    Ok(())
}

fn encrypt_meta(
    dek: &[u8; 32],
    salt: &[u8; 16],
    id: &str,
    dek_ver: u32,
    meta: &RecordMeta,
) -> Result<([u8; 12], Vec<u8>), VaultError> {
    let rk = kdf::derive_record_key(dek, salt, id, "meta", dek_ver)?;
    let aad = record_aad(id, "meta", dek_ver, DATA_VERSION);
    let plaintext = Zeroizing::new(serde_json::to_vec(meta)?);
    let sealed = aead::seal(&rk, &plaintext, &aad)?;
    Ok((sealed.nonce, sealed.ciphertext))
}

fn encrypt_secret(
    dek: &[u8; 32],
    salt: &[u8; 16],
    id: &str,
    dek_ver: u32,
    secret: &RecordSecret,
) -> Result<([u8; 12], Vec<u8>), VaultError> {
    let rk = kdf::derive_record_key(dek, salt, id, "secret", dek_ver)?;
    let aad = record_aad(id, "secret", dek_ver, DATA_VERSION);
    let plaintext = Zeroizing::new(serde_json::to_vec(secret)?);
    let sealed = aead::seal(&rk, &plaintext, &aad)?;
    Ok((sealed.nonce, sealed.ciphertext))
}

fn decrypt_meta(
    dek: &[u8; 32],
    salt: &[u8; 16],
    rec: &StoredRecord,
) -> Result<RecordMeta, VaultError> {
    let rk = kdf::derive_record_key(dek, salt, &rec.id, "meta", rec.dek_ver)?;
    let aad = record_aad(&rec.id, "meta", rec.dek_ver, rec.data_ver);
    let plain = aead::open(&rk, &rec.meta_nonce, &rec.meta_ct, &aad)?;
    serde_json::from_slice(&plain).map_err(|_| VaultError::corrupt())
}

fn decrypt_secret(
    dek: &[u8; 32],
    salt: &[u8; 16],
    rec: &StoredRecord,
) -> Result<RecordSecret, VaultError> {
    let rk = kdf::derive_record_key(dek, salt, &rec.id, "secret", rec.dek_ver)?;
    let aad = record_aad(&rec.id, "secret", rec.dek_ver, rec.data_ver);
    let plain = aead::open(&rk, &rec.secret_nonce, &rec.secret_ct, &aad)?;
    serde_json::from_slice(&plain).map_err(|_| VaultError::corrupt())
}

fn make_stored(
    id: String,
    rev: i64,
    dek_ver: u32,
    dek: &[u8; 32],
    salt: &[u8; 16],
    meta: &RecordMeta,
    secret: &RecordSecret,
    tombstone: i64,
) -> Result<StoredRecord, VaultError> {
    let (meta_nonce, meta_ct) = encrypt_meta(dek, salt, &id, dek_ver, meta)?;
    let (secret_nonce, secret_ct) = encrypt_secret(dek, salt, &id, dek_ver, secret)?;
    Ok(StoredRecord {
        id,
        rev,
        dek_ver,
        alg_ver: ALG_VERSION,
        data_ver: DATA_VERSION,
        meta_nonce,
        meta_ct,
        secret_nonce,
        secret_ct,
        tombstone,
    })
}

fn build_item(meta: &RecordMeta, index: &VaultIndex, last_used: Option<&String>) -> RecordListItem {
    RecordListItem {
        id: meta.id.clone(),
        rev: meta.rev,
        record_type: meta.record_type.clone(),
        title: meta.title.clone(),
        username: meta.username.clone(),
        email: meta.email.clone(),
        url: meta.url.clone(),
        platform: meta.platform.clone(),
        category_id: meta.category_id.clone(),
        category_name: index
            .category_names
            .get(&meta.category_id)
            .cloned()
            .unwrap_or_default(),
        tag_ids: meta.tag_ids.clone(),
        tag_names: meta
            .tag_ids
            .iter()
            .filter_map(|t| index.tag_names.get(t).cloned())
            .collect(),
        favorite: meta.favorite,
        updated_at: meta.updated_at.clone(),
        last_used_at: last_used.cloned(),
        field_count: meta.field_count,
    }
}

// ── 状态与生命周期 ───────────────────────────────────────────

#[tauri::command]
pub fn vault_status(state: State<'_, Arc<VaultState>>) -> Result<VaultStatusDto, VaultError> {
    let s = state.session.read();
    Ok(VaultStatusDto {
        state: s.runtime,
        has_vault: state.has_vault(),
        unlocked: s.is_unlocked(),
        recovery_mode: s.runtime == RuntimeState::Recovery,
        record_count: if s.is_unlocked() || s.runtime == RuntimeState::Recovery {
            Some(s.index.rows.len())
        } else {
            None
        },
        lock: if s.is_unlocked() || s.runtime == RuntimeState::Recovery {
            Some(s.lock_settings.clone())
        } else {
            None
        },
        startup_error: state.startup_error.lock().clone(),
        last_lock_reason: s.last_lock_reason.map(|r| r.code().to_string()),
    })
}

#[tauri::command]
pub async fn vault_create(
    state: State<'_, Arc<VaultState>>,
    master_password: String,
) -> Result<CreateVaultDto, VaultError> {
    let _gate = state.unlock_gate.lock().await;
    if state.has_vault() {
        return Err(VaultError::already_exists());
    }
    validate_master_password(&master_password)?;

    let vault_id = uuid::Uuid::new_v4().to_string();
    let vault_salt: [u8; 16] = random_array()?;
    let kdf_salt: [u8; 16] = random_array()?;
    let dek: Zeroizing<[u8; 32]> = Zeroizing::new(random_array()?);
    let recovery_bytes: [u8; 20] = random_array()?;
    let params = Argon2Params::baseline();

    let master_kek = kdf::derive_master_kek(&master_password, &kdf_salt, &params)?;
    let recovery_kek = kdf::derive_recovery_kek(&recovery_bytes)?;

    let master_wrap = envelope::wrap_dek(&master_kek, &dek, &vault_id, "master")?;
    let recovery_wrap = envelope::wrap_dek(&recovery_kek, &dek, &vault_id, "recovery")?;
    let created_at = now_iso();

    let master_env = Envelope {
        format: crate::secure_vault::crypto::ENVELOPE_FORMAT.to_string(),
        version: crate::secure_vault::crypto::ENVELOPE_VERSION,
        vault_id: vault_id.clone(),
        slot: "master".to_string(),
        kdf: KdfInfo {
            alg: "argon2id".to_string(),
            lib_version: Some(19),
            m_cost_kib: Some(params.m_cost_kib),
            t_cost: Some(params.t_cost),
            p_cost: Some(params.p_cost),
            salt_b64: secret_bytes::b64_encode(&kdf_salt),
        },
        wrap: master_wrap,
        dek_ver: 1,
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
    };
    let recovery_env = Envelope {
        format: crate::secure_vault::crypto::ENVELOPE_FORMAT.to_string(),
        version: crate::secure_vault::crypto::ENVELOPE_VERSION,
        vault_id: vault_id.clone(),
        slot: "recovery".to_string(),
        kdf: KdfInfo {
            alg: "hkdf-sha256".to_string(),
            lib_version: None,
            m_cost_kib: None,
            t_cost: None,
            p_cost: None,
            salt_b64: String::new(),
        },
        wrap: recovery_wrap,
        dek_ver: 1,
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
    };

    let store = VaultStore::open(&state.store_path())?;
    crate::secure_vault::store::bootstrap(
        &store,
        &Bootstrap {
            vault_id: vault_id.clone(),
            vault_salt_b64: secret_bytes::b64_encode(&vault_salt),
            argon2: params,
            dek_ver: 1,
            master_envelope: master_env.to_json()?,
            recovery_envelope: recovery_env.to_json()?,
            created_at: created_at.clone(),
        },
        &dek,
    )?;
    save_lock_settings(&store, &dek, &vault_salt, 1, &LockSettings::default())?;
    store.audit("vault_create", "ok", None, None)?;
    state.insert_store(store);

    {
        let mut s = state.session.write();
        s.runtime = RuntimeState::Unlocked;
        s.dek = Some(Zeroizing::new(*dek));
        s.dek_ver = 1;
        s.vault_id = vault_id.clone();
        s.vault_salt = vault_salt;
        s.index = VaultIndex::default();
        s.lock_settings = LockSettings::default();
        s.last_activity = Instant::now();
        s.last_lock_reason = None;
    }
    write_crash_marker(state.inner(), &vault_id);

    let recovery_code = secret_bytes::encode_recovery(&recovery_bytes);
    let groups = secret_bytes::recovery_groups(&recovery_code);
    Ok(CreateVaultDto {
        vault_id,
        recovery_code,
        recovery_groups: groups,
        kdf: master_env.kdf,
        created_at,
        unlocked: true,
    })
}

#[tauri::command]
pub fn vault_create_confirm_recovery(
    state: State<'_, Arc<VaultState>>,
    ack: bool,
) -> Result<(), VaultError> {
    if !ack {
        return Err(VaultError::validation("恢复密钥确认", "必须先抄写并确认"));
    }
    state.with_store(|store| store.set_meta("recovery_ack", "1"))
}

#[tauri::command]
pub async fn vault_unlock(
    state: State<'_, Arc<VaultState>>,
    credential: UnlockCredential,
) -> Result<UnlockDto, VaultError> {
    let _gate = state.unlock_gate.lock().await;
    if !state.has_vault() {
        return Err(VaultError::not_found());
    }
    if state.session.read().is_unlocked() {
        return Ok(UnlockDto {
            state: RuntimeState::Unlocked,
            used_slot: "master".to_string(),
        });
    }
    let slot = match credential.kind.as_str() {
        "password" => "master",
        "recovery" => "recovery",
        _ => return Err(VaultError::validation("解锁方式", "未知方式")),
    };

    if let Some(until) = cooldown_remaining(state.inner())? {
        return Err(VaultError::cooldown(until));
    }

    let stored = state
        .with_store(|s| s.get_envelope(slot))?
        .ok_or_else(VaultError::not_found)?;
    let env = Envelope::from_json(&stored.envelope_json)?;

    let kek = if slot == "master" {
        let params = env.argon2_params()?;
        let salt = env.salt()?;
        let password = credential.value.clone();
        tauri::async_runtime::spawn_blocking(move || {
            kdf::derive_master_kek(&password, &salt, &params)
        })
        .await
        .map_err(|_| VaultError::internal("join"))??
    } else {
        let bytes = secret_bytes::parse_recovery(&credential.value)?;
        kdf::derive_recovery_kek(&bytes)?
    };

    let dek = match envelope::unwrap_dek(&kek, &env.wrap, &env.vault_id, slot) {
        Ok(d) => d,
        Err(_) => {
            record_failure(state.inner())?;
            return Err(if slot == "master" {
                VaultError::bad_password()
            } else {
                VaultError::bad_recovery_key()
            });
        }
    };

    let salt_b64 = state
        .with_store(|s| s.get_meta("vault_salt"))?
        .ok_or_else(VaultError::corrupt)?;
    let salt = decode_salt(&salt_b64)?;

    let expected = state
        .with_store(|s| s.get_meta("digest_hmac"))?
        .ok_or_else(VaultError::corrupt)?;
    let actual = crate::secure_vault::crypto::secret_bytes::b64_encode(
        &state.with_store(|s| s.digest_of(&dek, &salt))?,
    );
    if expected != actual {
        return Err(VaultError::corrupt());
    }

    let (index, settings) = load_index(state.inner(), &dek, &salt, env.dek_ver)?;
    reset_failure(state.inner())?;

    {
        let mut s = state.session.write();
        s.runtime = if slot == "recovery" {
            RuntimeState::Recovery
        } else {
            RuntimeState::Unlocked
        };
        s.dek = Some(Zeroizing::new(*dek));
        s.dek_ver = env.dek_ver;
        s.vault_id = env.vault_id.clone();
        s.vault_salt = salt;
        s.index = index;
        s.lock_settings = settings;
        s.last_activity = Instant::now();
        s.background_since = None;
        s.last_lock_reason = None;
    }
    let vault_id = env.vault_id.clone();
    write_crash_marker(state.inner(), &vault_id);
    let _ = state.with_store(|s| s.audit("unlock", "ok", Some(slot), None));
    Ok(UnlockDto {
        state: if slot == "recovery" {
            RuntimeState::Recovery
        } else {
            RuntimeState::Unlocked
        },
        used_slot: slot.to_string(),
    })
}

#[tauri::command]
pub fn vault_lock(
    state: State<'_, Arc<VaultState>>,
    reason: Option<String>,
) -> Result<(), VaultError> {
    let reason = match reason.as_deref() {
        Some("idle") => LockReason::Idle,
        Some("background") => LockReason::Background,
        Some("system_lock") => LockReason::SystemLock,
        Some("sleep") => LockReason::Sleep,
        Some("window_hidden") => LockReason::WindowHidden,
        _ => LockReason::Manual,
    };
    state.lock(reason);
    Ok(())
}

#[tauri::command]
pub fn vault_touch(state: State<'_, Arc<VaultState>>) -> Result<(), VaultError> {
    state.note_activity();
    Ok(())
}

#[tauri::command]
pub fn vault_app_background(
    state: State<'_, Arc<VaultState>>,
    background: bool,
) -> Result<(), VaultError> {
    state.on_background(background);
    Ok(())
}

#[tauri::command]
pub async fn vault_change_master_password(
    state: State<'_, Arc<VaultState>>,
    current: String,
    new_password: String,
) -> Result<(), VaultError> {
    let _gate = state.unlock_gate.lock().await;
    let dek = require_unlocked(state.inner())?;
    validate_master_password(&new_password)?;
    let old_env = state
        .with_store(|s| s.get_envelope("master"))?
        .ok_or_else(VaultError::not_found)?;
    let parsed = Envelope::from_json(&old_env.envelope_json)?;
    let salt = parsed.salt()?;
    let params = parsed.argon2_params()?;
    let password = current.clone();
    let old_kek = tauri::async_runtime::spawn_blocking(move || {
        kdf::derive_master_kek(&password, &salt, &params)
    })
    .await
    .map_err(|_| VaultError::internal("join"))??;
    if envelope::unwrap_dek(&old_kek, &parsed.wrap, &parsed.vault_id, "master").is_err() {
        return Err(VaultError::bad_password());
    }

    let new_salt: [u8; 16] = random_array()?;
    let new_params = Argon2Params::baseline();
    let new_password_copy = new_password.clone();
    let new_kek = tauri::async_runtime::spawn_blocking(move || {
        kdf::derive_master_kek(&new_password_copy, &new_salt, &new_params)
    })
    .await
    .map_err(|_| VaultError::internal("join"))??;
    let wrap = envelope::wrap_dek(&new_kek, &dek, &parsed.vault_id, "master")?;
    let now = now_iso();
    let new_env = Envelope {
        format: crate::secure_vault::crypto::ENVELOPE_FORMAT.to_string(),
        version: crate::secure_vault::crypto::ENVELOPE_VERSION,
        vault_id: parsed.vault_id.clone(),
        slot: "master".to_string(),
        kdf: KdfInfo {
            alg: "argon2id".to_string(),
            lib_version: Some(19),
            m_cost_kib: Some(new_params.m_cost_kib),
            t_cost: Some(new_params.t_cost),
            p_cost: Some(new_params.p_cost),
            salt_b64: secret_bytes::b64_encode(&new_salt),
        },
        wrap,
        dek_ver: parsed.dek_ver,
        created_at: parsed.created_at.clone(),
        updated_at: now.clone(),
    };
    state.with_store(|s| {
        s.put_envelope("master", &new_env.to_json()?, parsed.dek_ver, &now)?;
        s.set_meta("master_reforged_at", &now)?;
        s.audit("change_master_password", "ok", None, None)
    })?;
    Ok(())
}

#[tauri::command]
pub async fn vault_recover_set_password(
    state: State<'_, Arc<VaultState>>,
    new_password: String,
) -> Result<(), VaultError> {
    let _gate = state.unlock_gate.lock().await;
    let (dek, vault_id, dek_ver) = {
        let s = state.session.read();
        if s.runtime != RuntimeState::Recovery {
            return Err(VaultError::recovery_readonly());
        }
        (
            s.dek_copy().ok_or_else(VaultError::locked)?,
            s.vault_id.clone(),
            s.dek_ver,
        )
    };
    validate_master_password(&new_password)?;
    let new_salt: [u8; 16] = random_array()?;
    let params = Argon2Params::baseline();
    let password = new_password.clone();
    let kek = tauri::async_runtime::spawn_blocking(move || {
        kdf::derive_master_kek(&password, &new_salt, &params)
    })
    .await
    .map_err(|_| VaultError::internal("join"))??;
    let wrap = envelope::wrap_dek(&kek, &dek, &vault_id, "master")?;
    let now = now_iso();
    let env = Envelope {
        format: crate::secure_vault::crypto::ENVELOPE_FORMAT.to_string(),
        version: crate::secure_vault::crypto::ENVELOPE_VERSION,
        vault_id,
        slot: "master".to_string(),
        kdf: KdfInfo {
            alg: "argon2id".to_string(),
            lib_version: Some(19),
            m_cost_kib: Some(params.m_cost_kib),
            t_cost: Some(params.t_cost),
            p_cost: Some(params.p_cost),
            salt_b64: secret_bytes::b64_encode(&new_salt),
        },
        wrap,
        dek_ver,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    state.with_store(|s| {
        s.put_envelope("master", &env.to_json()?, dek_ver, &now)?;
        s.audit("recover_set_password", "ok", None, None)
    })?;
    {
        let mut s = state.session.write();
        s.runtime = RuntimeState::Unlocked;
        s.last_activity = Instant::now();
    }
    Ok(())
}

#[tauri::command]
pub fn vault_regenerate_recovery_key(
    state: State<'_, Arc<VaultState>>,
) -> Result<Vec<String>, VaultError> {
    let (dek, vault_id, dek_ver) = {
        let s = state.session.read();
        if !s.is_unlocked() {
            return Err(VaultError::locked());
        }
        (
            s.dek_copy().ok_or_else(VaultError::locked)?,
            s.vault_id.clone(),
            s.dek_ver,
        )
    };
    let bytes: [u8; 20] = random_array()?;
    let kek = kdf::derive_recovery_kek(&bytes)?;
    let wrap = envelope::wrap_dek(&kek, &dek, &vault_id, "recovery")?;
    let now = now_iso();
    let env = Envelope {
        format: crate::secure_vault::crypto::ENVELOPE_FORMAT.to_string(),
        version: crate::secure_vault::crypto::ENVELOPE_VERSION,
        vault_id,
        slot: "recovery".to_string(),
        kdf: KdfInfo {
            alg: "hkdf-sha256".to_string(),
            lib_version: None,
            m_cost_kib: None,
            t_cost: None,
            p_cost: None,
            salt_b64: String::new(),
        },
        wrap,
        dek_ver,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    state.with_store(|s| {
        s.put_envelope("recovery", &env.to_json()?, dek_ver, &now)?;
        s.audit("regenerate_recovery", "ok", None, None)
    })?;
    let code = secret_bytes::encode_recovery(&bytes);
    Ok(secret_bytes::recovery_groups(&code))
}

#[tauri::command]
pub fn vault_delete(state: State<'_, Arc<VaultState>>, confirm: String) -> Result<(), VaultError> {
    if confirm != DELETE_CONFIRM {
        return Err(VaultError::validation(
            "确认文本",
            "必须逐字输入 DELETE VAULT",
        ));
    }
    let dek = require_unlocked(state.inner())?;
    drop(dek);
    {
        let mut s = state.session.write();
        s.clear(LockReason::Manual);
        s.runtime = RuntimeState::NoVault;
        s.last_lock_reason = None;
    }
    *state.store.lock() = None;
    let path = state.store_path();
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
    remove_crash_marker(state.inner());
    Ok(())
}

// ── 记录 ─────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_record_list(
    state: State<'_, Arc<VaultState>>,
    record_type: Option<String>,
    category_id: Option<String>,
    tag_id: Option<String>,
    favorite_only: Option<bool>,
    query: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<RecordListItem>, VaultError> {
    let _ = require_unlocked(state.inner())?;
    let s = state.session.read();
    let q = query.unwrap_or_default().to_lowercase();
    let mut rows: Vec<RecordListItem> = s
        .index
        .rows
        .iter()
        .filter(|m| {
            if let Some(t) = &record_type {
                if t != "all" && &m.record_type != t {
                    return false;
                }
            }
            if let Some(c) = &category_id {
                if c != "all" && &m.category_id != c {
                    return false;
                }
            }
            if let Some(t) = &tag_id {
                if !m.tag_ids.contains(t) {
                    return false;
                }
            }
            if favorite_only.unwrap_or(false) && !m.favorite {
                return false;
            }
            if !q.is_empty() {
                let cat = s
                    .index
                    .category_names
                    .get(&m.category_id)
                    .cloned()
                    .unwrap_or_default();
                let tags: String = m
                    .tag_ids
                    .iter()
                    .filter_map(|t| s.index.tag_names.get(t))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" ");
                let hay = format!(
                    "{} {} {} {} {} {} {}",
                    m.title, m.username, m.email, m.url, m.platform, cat, m.note
                ) + &tags;
                if !hay.to_lowercase().contains(&q) {
                    return false;
                }
            }
            true
        })
        .map(|m| build_item(m, &s.index, s.index.usage.get(&m.id)))
        .collect();
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let off = offset.unwrap_or(0) as usize;
    let lim = limit.unwrap_or(50).clamp(1, 200) as usize;
    Ok(rows.into_iter().skip(off).take(lim).collect())
}

#[tauri::command]
pub fn vault_record_get(
    state: State<'_, Arc<VaultState>>,
    id: String,
    reveal: Option<Vec<String>>,
) -> Result<RecordDetailDto, VaultError> {
    let dek = require_unlocked(state.inner())?;
    let salt = session_salt(state.inner())?;
    let rec = state
        .with_store(|s| s.get_record(&id))?
        .ok_or_else(VaultError::not_found)?;
    if rec.tombstone != 0 {
        return Err(VaultError::not_found());
    }
    let meta = decrypt_meta(&dek, &salt, &rec)?;
    let secret = decrypt_secret(&dek, &salt, &rec)?;
    let reveal = reveal.unwrap_or_default();
    let index = state.session.read().index.clone_shallow();
    let last_used = index.usage.get(&id).cloned();
    let fields = secret
        .fields
        .into_iter()
        .map(|f| {
            let shown = reveal.contains(&f.id);
            RecordFieldView {
                id: f.id,
                label: f.label,
                kind: f.kind,
                revealed: shown,
                value: if shown { f.value } else { String::new() },
            }
        })
        .collect();
    let item = build_item(&meta, &index, last_used.as_ref());
    let _ = mark_used_inner(state.inner(), &id);
    Ok(RecordDetailDto {
        id: item.id,
        rev: rec.rev,
        record_type: item.record_type,
        title: item.title,
        username: item.username,
        email: item.email,
        url: item.url,
        platform: item.platform,
        category_id: item.category_id,
        category_name: item.category_name,
        tag_ids: item.tag_ids,
        tag_names: item.tag_names,
        favorite: item.favorite,
        note: meta.note,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        last_used_at: last_used,
        fields,
    })
}

#[tauri::command]
pub async fn vault_record_create(
    state: State<'_, Arc<VaultState>>,
    draft: RecordDraft,
) -> Result<IdRevDto, VaultError> {
    let _gate = state.write_gate.lock().await;
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    validate_draft(&draft)?;
    let id = uuid::Uuid::new_v4().to_string();
    let rev = state.with_store(|s| s.next_rev())?;
    let now = now_iso();
    let meta = RecordMeta {
        id: id.clone(),
        rev,
        field_count: draft.fields.len(),
        record_type: draft.record_type,
        title: draft.title.trim().to_string(),
        username: draft.username,
        email: draft.email,
        url: draft.url,
        platform: draft.platform,
        category_id: draft.category_id,
        tag_ids: draft.tag_ids,
        favorite: draft.favorite,
        note: draft.note,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    let secret = RecordSecret {
        version: 1,
        fields: draft.fields,
    };
    let stored = make_stored(id.clone(), rev, 1, &dek, &salt, &meta, &secret, 0)?;
    state.with_store(|s| s.write_record(&stored, rev + 1, &dek, &salt))?;
    {
        let mut s = state.session.write();
        if s.is_unlocked() {
            s.index.insert(meta);
        }
    }
    state.with_store(|s| s.audit("record_create", "ok", None, Some(1)))?;
    Ok(IdRevDto { id, rev })
}

#[tauri::command]
pub async fn vault_record_update(
    state: State<'_, Arc<VaultState>>,
    id: String,
    expected_rev: i64,
    patch: RecordPatch,
) -> Result<IdRevDto, VaultError> {
    let _gate = state.write_gate.lock().await;
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    let rec = state
        .with_store(|s| s.get_record(&id))?
        .ok_or_else(VaultError::not_found)?;
    if rec.rev != expected_rev {
        return Err(VaultError::conflict(expected_rev, rec.rev));
    }
    let mut meta = decrypt_meta(&dek, &salt, &rec)?;
    let secret = decrypt_secret(&dek, &salt, &rec)?;
    if let Some(v) = patch.title {
        meta.title = v.trim().to_string();
    }
    if let Some(v) = patch.username {
        meta.username = v;
    }
    if let Some(v) = patch.email {
        meta.email = v;
    }
    if let Some(v) = patch.url {
        meta.url = v;
    }
    if let Some(v) = patch.platform {
        meta.platform = v;
    }
    if let Some(v) = patch.category_id {
        meta.category_id = v;
    }
    if let Some(v) = patch.tag_ids {
        meta.tag_ids = v;
    }
    if let Some(v) = patch.favorite {
        meta.favorite = v;
    }
    if let Some(v) = patch.note {
        meta.note = v;
    }
    let fields = patch.fields.unwrap_or(secret.fields);
    validate_fields(&fields)?;
    if meta.title.is_empty() || meta.title.chars().count() > 200 {
        return Err(VaultError::validation("标题", "须为 1–200 字符"));
    }
    if meta.note.chars().count() > 4000 {
        return Err(VaultError::validation("备注", "不能超过 4000 字符"));
    }
    let rev = state.with_store(|s| s.next_rev())?;
    meta.rev = rev;
    meta.field_count = fields.len();
    meta.updated_at = now_iso();
    let secret = RecordSecret { version: 1, fields };
    let stored = make_stored(
        id.clone(),
        rev,
        1,
        &dek,
        &salt,
        &meta,
        &secret,
        rec.tombstone,
    )?;
    state.with_store(|s| s.write_record(&stored, rev + 1, &dek, &salt))?;
    {
        let mut s = state.session.write();
        if s.is_unlocked() && rec.tombstone == 0 {
            s.index.insert(meta);
        }
    }
    Ok(IdRevDto { id, rev })
}

#[tauri::command]
pub async fn vault_record_delete(
    state: State<'_, Arc<VaultState>>,
    id: String,
) -> Result<(), VaultError> {
    let _gate = state.write_gate.lock().await;
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    let rec = state
        .with_store(|s| s.get_record(&id))?
        .ok_or_else(VaultError::not_found)?;
    let rev = state.with_store(|s| s.next_rev())?;
    let mut stored = rec.clone();
    stored.rev = rev;
    stored.tombstone = 1;
    state.with_store(|s| s.write_record(&stored, rev + 1, &dek, &salt))?;
    {
        let mut s = state.session.write();
        s.index.remove(&id);
    }
    state.with_store(|s| s.audit("record_delete", "ok", None, Some(1)))?;
    Ok(())
}

#[tauri::command]
pub async fn vault_record_restore(
    state: State<'_, Arc<VaultState>>,
    id: String,
) -> Result<(), VaultError> {
    let _gate = state.write_gate.lock().await;
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    let rec = state
        .with_store(|s| s.get_record(&id))?
        .ok_or_else(VaultError::not_found)?;
    if rec.tombstone == 0 {
        return Ok(());
    }
    let meta = decrypt_meta(&dek, &salt, &rec)?;
    let rev = state.with_store(|s| s.next_rev())?;
    let mut stored = rec.clone();
    stored.rev = rev;
    stored.tombstone = 0;
    state.with_store(|s| s.write_record(&stored, rev + 1, &dek, &salt))?;
    {
        let mut s = state.session.write();
        if s.is_unlocked() {
            let mut meta = meta;
            meta.rev = rev;
            s.index.insert(meta);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn vault_record_toggle_favorite(
    state: State<'_, Arc<VaultState>>,
    id: String,
) -> Result<bool, VaultError> {
    let _gate = state.write_gate.lock().await;
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    let rec = state
        .with_store(|s| s.get_record(&id))?
        .ok_or_else(VaultError::not_found)?;
    let mut meta = decrypt_meta(&dek, &salt, &rec)?;
    meta.favorite = !meta.favorite;
    let rev = state.with_store(|s| s.next_rev())?;
    meta.rev = rev;
    meta.updated_at = now_iso();
    let secret = decrypt_secret(&dek, &salt, &rec)?;
    let stored = make_stored(
        id.clone(),
        rev,
        rec.dek_ver,
        &dek,
        &salt,
        &meta,
        &secret,
        rec.tombstone,
    )?;
    state.with_store(|s| s.write_record(&stored, rev + 1, &dek, &salt))?;
    {
        let mut s = state.session.write();
        if s.is_unlocked() {
            s.index.insert(meta.clone());
        }
    }
    Ok(meta.favorite)
}

#[tauri::command]
pub fn vault_record_mark_used(
    state: State<'_, Arc<VaultState>>,
    id: String,
) -> Result<(), VaultError> {
    mark_used_inner(state.inner(), &id)
}

#[tauri::command]
pub fn vault_search_records(
    state: State<'_, Arc<VaultState>>,
    query: String,
) -> Result<Vec<RecordListItem>, VaultError> {
    vault_record_list(
        state,
        None,
        None,
        None,
        None,
        Some(query),
        Some(200),
        Some(0),
    )
}

// ── 分类与标签 ───────────────────────────────────────────────

#[tauri::command]
pub fn vault_category_list(
    state: State<'_, Arc<VaultState>>,
) -> Result<Vec<CategoryDto>, VaultError> {
    let _ = require_unlocked(state.inner())?;
    let s = state.session.read();
    let rows = state.with_store(|st| st.load_categories())?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(name) = s.index.category_names.get(&row.id) {
            out.push(CategoryDto {
                id: row.id,
                name: name.clone(),
                sort_order: row.sort_order,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn vault_category_create(
    state: State<'_, Arc<VaultState>>,
    name: String,
) -> Result<CategoryDto, VaultError> {
    let _gate = state.write_gate.lock().await;
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 40 {
        return Err(VaultError::validation("分类名称", "须为 1–40 字符"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let sort_order = state.with_store(|s| s.load_categories())?.len() as i64;
    let rk = kdf::derive_record_key(&dek, &salt, &id, "category", 1)?;
    let aad = format!("tdcat|{id}|v1");
    let sealed = aead::seal(&rk, trimmed.as_bytes(), &aad)?;
    let row = StoredName {
        id: id.clone(),
        sort_order,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        dek_ver: 1,
    };
    state.with_store(|s| s.put_category(&row))?;
    {
        let mut s = state.session.write();
        s.index.category_names.insert(id.clone(), trimmed.clone());
    }
    Ok(CategoryDto {
        id,
        name: trimmed,
        sort_order,
    })
}

#[tauri::command]
pub async fn vault_category_rename(
    state: State<'_, Arc<VaultState>>,
    id: String,
    name: String,
) -> Result<(), VaultError> {
    let _gate = state.write_gate.lock().await;
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 40 {
        return Err(VaultError::validation("分类名称", "须为 1–40 字符"));
    }
    let rows = state.with_store(|s| s.load_categories())?;
    let mut row = rows
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(VaultError::not_found)?;
    let rk = kdf::derive_record_key(&dek, &salt, &id, "category", row.dek_ver)?;
    let aad = format!("tdcat|{id}|v{}", row.dek_ver);
    let sealed = aead::seal(&rk, trimmed.as_bytes(), &aad)?;
    row.nonce = sealed.nonce;
    row.ciphertext = sealed.ciphertext;
    state.with_store(|s| s.put_category(&row))?;
    state
        .session
        .write()
        .index
        .category_names
        .insert(id, trimmed);
    Ok(())
}

#[tauri::command]
pub async fn vault_category_delete(
    state: State<'_, Arc<VaultState>>,
    id: String,
    confirm_affected: Option<bool>,
) -> Result<DeleteCategoryDto, VaultError> {
    let _gate = state.write_gate.lock().await;
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    let affected: Vec<String> = {
        let s = state.session.read();
        s.index
            .rows
            .iter()
            .filter(|m| m.category_id == id)
            .map(|m| m.id.clone())
            .collect()
    };
    if !affected.is_empty() && !confirm_affected.unwrap_or(false) {
        return Err(VaultError::validation(
            "删除分类",
            "仍有记录引用该分类，需要二次确认",
        ));
    }
    for rid in &affected {
        let rec = state
            .with_store(|s| s.get_record(rid))?
            .ok_or_else(VaultError::not_found)?;
        let mut meta = decrypt_meta(&dek, &salt, &rec)?;
        meta.category_id.clear();
        let rev = state.with_store(|s| s.next_rev())?;
        meta.rev = rev;
        let stored = make_stored(
            rid.clone(),
            rev,
            rec.dek_ver,
            &dek,
            &salt,
            &meta,
            &decrypt_secret(&dek, &salt, &rec)?,
            rec.tombstone,
        )?;
        state.with_store(|s| s.write_record(&stored, rev + 1, &dek, &salt))?;
        state.session.write().index.insert(meta);
    }
    state.with_store(|s| s.delete_category(&id))?;
    state.session.write().index.category_names.remove(&id);
    Ok(DeleteCategoryDto {
        affected_records: affected.len(),
    })
}

#[tauri::command]
pub fn vault_tag_list(state: State<'_, Arc<VaultState>>) -> Result<Vec<CategoryDto>, VaultError> {
    let _ = require_unlocked(state.inner())?;
    let s = state.session.read();
    let rows = state.with_store(|st| st.load_tags())?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(name) = s.index.tag_names.get(&row.id) {
            out.push(CategoryDto {
                id: row.id,
                name: name.clone(),
                sort_order: 0,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn vault_tag_create(
    state: State<'_, Arc<VaultState>>,
    name: String,
) -> Result<CategoryDto, VaultError> {
    let _gate = state.write_gate.lock().await;
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 24 {
        return Err(VaultError::validation("标签名称", "须为 1–24 字符"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let rk = kdf::derive_record_key(&dek, &salt, &id, "tag", 1)?;
    let aad = format!("tdtag|{id}|v1");
    let sealed = aead::seal(&rk, trimmed.as_bytes(), &aad)?;
    let row = StoredName {
        id: id.clone(),
        sort_order: 0,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        dek_ver: 1,
    };
    state.with_store(|s| s.put_tag(&row))?;
    state
        .session
        .write()
        .index
        .tag_names
        .insert(id.clone(), trimmed.clone());
    Ok(CategoryDto {
        id,
        name: trimmed,
        sort_order: 0,
    })
}

#[tauri::command]
pub async fn vault_tag_rename(
    state: State<'_, Arc<VaultState>>,
    id: String,
    name: String,
) -> Result<(), VaultError> {
    let _gate = state.write_gate.lock().await;
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > 24 {
        return Err(VaultError::validation("标签名称", "须为 1–24 字符"));
    }
    let rows = state.with_store(|s| s.load_tags())?;
    let mut row = rows
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(VaultError::not_found)?;
    let rk = kdf::derive_record_key(&dek, &salt, &id, "tag", row.dek_ver)?;
    let aad = format!("tdtag|{id}|v{}", row.dek_ver);
    let sealed = aead::seal(&rk, trimmed.as_bytes(), &aad)?;
    row.nonce = sealed.nonce;
    row.ciphertext = sealed.ciphertext;
    state.with_store(|s| s.put_tag(&row))?;
    state.session.write().index.tag_names.insert(id, trimmed);
    Ok(())
}

#[tauri::command]
pub async fn vault_tag_delete(
    state: State<'_, Arc<VaultState>>,
    id: String,
) -> Result<DeleteCategoryDto, VaultError> {
    let _gate = state.write_gate.lock().await;
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    let affected: Vec<String> = {
        let s = state.session.read();
        s.index
            .rows
            .iter()
            .filter(|m| m.tag_ids.contains(&id))
            .map(|m| m.id.clone())
            .collect()
    };
    for rid in &affected {
        let rec = state
            .with_store(|s| s.get_record(rid))?
            .ok_or_else(VaultError::not_found)?;
        let mut meta = decrypt_meta(&dek, &salt, &rec)?;
        meta.tag_ids.retain(|t| t != &id);
        let rev = state.with_store(|s| s.next_rev())?;
        meta.rev = rev;
        let stored = make_stored(
            rid.clone(),
            rev,
            rec.dek_ver,
            &dek,
            &salt,
            &meta,
            &decrypt_secret(&dek, &salt, &rec)?,
            rec.tombstone,
        )?;
        state.with_store(|s| s.write_record(&stored, rev + 1, &dek, &salt))?;
        state.session.write().index.insert(meta);
    }
    state.with_store(|s| s.delete_tag(&id))?;
    state.session.write().index.tag_names.remove(&id);
    Ok(DeleteCategoryDto {
        affected_records: affected.len(),
    })
}

// ── 设置 / 密码 / 剪贴板 ─────────────────────────────────────

#[tauri::command]
pub fn vault_settings_get(state: State<'_, Arc<VaultState>>) -> Result<LockSettings, VaultError> {
    let _ = require_unlocked(state.inner())?;
    Ok(state.session.read().lock_settings.clone())
}

#[tauri::command]
pub fn vault_settings_set(
    state: State<'_, Arc<VaultState>>,
    settings: LockSettings,
) -> Result<(), VaultError> {
    let dek = require_writable(state.inner())?;
    let salt = session_salt(state.inner())?;
    settings.validate()?;
    let store_settings = state.with_store(|s| {
        save_lock_settings(s, &dek, &salt, 1, &settings)?;
        s.audit("settings_update", "ok", None, None)
    });
    store_settings?;
    state.session.write().lock_settings = settings;
    Ok(())
}

#[tauri::command]
pub fn vault_generate_password(
    options: password_gen::GenerateOptions,
) -> Result<password_gen::GeneratedDto, VaultError> {
    password_gen::generate(&options)
}

#[tauri::command]
pub fn vault_evaluate_password_strength(
    password: String,
) -> Result<password_gen::StrengthDto, VaultError> {
    Ok(password_gen::evaluate(&password))
}

#[tauri::command]
pub fn vault_copy_secret(
    state: State<'_, Arc<VaultState>>,
    record_id: String,
    field_id: String,
    clear_after_secs: Option<u16>,
) -> Result<CopyReceiptDto, VaultError> {
    let dek = require_unlocked(state.inner())?;
    let salt = session_salt(state.inner())?;
    let rec = state
        .with_store(|s| s.get_record(&record_id))?
        .ok_or_else(VaultError::not_found)?;
    let secret = decrypt_secret(&dek, &salt, &rec)?;
    let field = secret
        .fields
        .into_iter()
        .find(|f| f.id == field_id)
        .ok_or_else(VaultError::not_found)?;

    let rt =
        clipboard_runtime(&state.app).ok_or_else(|| VaultError::io("clipboard:unavailable"))?;
    let text = field.value;
    let payload = ClipboardPayload::Text {
        text: text.clone(),
        html: None,
    };
    platform::write_payload_notifying(&payload, &rt.self_write)
        .map_err(|e| VaultError::io(format!("clipboard:{e}")))?;

    let secs = clear_after_secs
        .map(|v| v as u64)
        .unwrap_or_else(|| state.session.read().lock_settings.clipboard_clear_secs)
        .clamp(5, 300);
    let token = uuid::Uuid::new_v4().to_string();
    let pending = PendingCopy {
        token: token.clone(),
        record_id: record_id.clone(),
        field_id,
        digest: sha256(text.as_bytes()),
        expires: Instant::now() + Duration::from_secs(secs),
        clear_after_secs: secs,
    };
    state.session.write().pending_copy = Some(pending);
    let _ = mark_used_inner(state.inner(), &record_id);

    let st = state.inner().clone();
    let token_clone = token.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(secs)).await;
        let _ = clear_clipboard_if_unchanged(&st, &token_clone);
    });
    Ok(CopyReceiptDto {
        cleared_after_secs: secs,
        token,
    })
}

#[tauri::command]
pub fn vault_clipboard_clear_now(
    state: State<'_, Arc<VaultState>>,
) -> Result<ClearResultDto, VaultError> {
    let token = state
        .session
        .read()
        .pending_copy
        .as_ref()
        .map(|p| p.token.clone());
    match token {
        Some(t) => clear_clipboard_if_unchanged(state.inner(), &t),
        None => Ok(ClearResultDto {
            cleared: false,
            reason: "nothing_pending".to_string(),
        }),
    }
}

// ── 审计 / 备份 ──────────────────────────────────────────────

#[tauri::command]
pub fn vault_audit_list(
    state: State<'_, Arc<VaultState>>,
) -> Result<Vec<AuditEventDto>, VaultError> {
    let rows = state.with_store(|s| s.load_audit(200))?;
    Ok(rows
        .into_iter()
        .map(|r| AuditEventDto {
            id: r.id,
            at: r.at,
            event: r.event,
            outcome: r.outcome,
            reason_code: r.reason_code,
            count: r.count,
        })
        .collect())
}

#[tauri::command]
pub async fn vault_export_backup(
    state: State<'_, Arc<VaultState>>,
    path: String,
    passphrase: String,
    include_settings: Option<bool>,
    overwrite: Option<bool>,
) -> Result<BackupSummaryDto, VaultError> {
    crate::secure_vault::backup::export_backup(
        state.inner(),
        &path,
        &passphrase,
        include_settings.unwrap_or(true),
        overwrite.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub fn vault_backup_inspect(path: String) -> Result<BackupInspectDto, VaultError> {
    let header = crate::secure_vault::backup::inspect(&path)?;
    Ok(BackupInspectDto {
        path,
        version: header.version,
        vault_id: header.vault_id,
        created_at: header.created_at,
        mode: header.mode,
        record_count: header.record_count,
        payload_len: header.payload_len,
    })
}

#[tauri::command]
pub async fn vault_backup_import(
    state: State<'_, Arc<VaultState>>,
    path: String,
    passphrase: String,
    new_master_password: String,
) -> Result<ImportResultDto, VaultError> {
    crate::secure_vault::backup::import_backup(
        state.inner(),
        &path,
        &passphrase,
        &new_master_password,
    )
    .await
}

// ── 内部实现 ─────────────────────────────────────────────────

fn clipboard_runtime(app: &AppHandle) -> Option<Arc<ClipboardRuntime>> {
    app.try_state::<Arc<ClipboardRuntime>>()
        .map(|s| s.inner().clone())
}

fn cooldown_remaining(state: &VaultState) -> Result<Option<i64>, VaultError> {
    let until = state
        .with_store(|s| s.get_meta("lockout_until"))?
        .unwrap_or_default();
    if until.is_empty() {
        return Ok(None);
    }
    let parsed = chrono::DateTime::parse_from_rfc3339(&until)
        .map_err(|_| VaultError::internal("lockout:parse"))?;
    let remain = parsed.timestamp() - chrono::Utc::now().timestamp();
    Ok(if remain > 0 { Some(remain) } else { None })
}

fn record_failure(state: &VaultState) -> Result<(), VaultError> {
    let count = state
        .with_store(|s| s.get_meta("fail_count"))?
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0)
        + 1;
    let cooldown = match count {
        0..=2 => 0,
        3 => 5,
        4 => 30,
        5 => 120,
        _ => 300,
    };
    let until = if cooldown > 0 {
        (chrono::Utc::now() + chrono::Duration::seconds(cooldown)).to_rfc3339()
    } else {
        String::new()
    };
    state.with_store(|s| {
        s.set_meta("fail_count", &count.to_string())?;
        s.set_meta("lockout_until", &until)?;
        s.audit("unlock", "failed", Some("wrong_credential"), None)
    })
}

fn reset_failure(state: &VaultState) -> Result<(), VaultError> {
    state.with_store(|s| {
        s.set_meta("fail_count", "0")?;
        s.set_meta("lockout_until", "")
    })
}

pub(crate) fn save_settings_public(
    store: &VaultStore,
    dek: &[u8; 32],
    salt: &[u8; 16],
    dek_ver: u32,
    settings: &LockSettings,
) -> Result<(), VaultError> {
    save_lock_settings(store, dek, salt, dek_ver, settings)
}

fn save_lock_settings(
    store: &VaultStore,
    dek: &[u8; 32],
    salt: &[u8; 16],
    dek_ver: u32,
    settings: &LockSettings,
) -> Result<(), VaultError> {
    let values = [
        ("auto_lock_idle_secs", serde_json::json!(settings.idle_secs)),
        (
            "auto_lock_background_secs",
            serde_json::json!(settings.background_secs),
        ),
        (
            "clipboard_clear_secs",
            serde_json::json!(settings.clipboard_clear_secs),
        ),
        ("reveal_secs", serde_json::json!(settings.reveal_secs)),
    ];
    for (key, value) in values {
        let rk = kdf::derive_record_key(dek, salt, key, "setting", dek_ver)?;
        let aad = format!("tdset|{key}|v{dek_ver}");
        let sealed = aead::seal(&rk, value.to_string().as_bytes(), &aad)?;
        store.put_setting(key, &sealed.nonce, &sealed.ciphertext, dek_ver)?;
    }
    Ok(())
}

fn load_settings(
    store: &VaultStore,
    dek: &[u8; 32],
    salt: &[u8; 16],
    _dek_ver: u32,
) -> Result<LockSettings, VaultError> {
    let mut out = LockSettings::default();
    for row in store.load_settings()? {
        let rk = kdf::derive_record_key(dek, salt, &row.key, "setting", row.dek_ver)?;
        let aad = format!("tdset|{}|v{}", row.key, row.dek_ver);
        let plain = match aead::open(&rk, &row.nonce, &row.ciphertext, &aad) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let value: serde_json::Value = match serde_json::from_slice(&plain) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let num = value.as_u64().unwrap_or(0);
        match row.key.as_str() {
            "auto_lock_idle_secs" => out.idle_secs = num,
            "auto_lock_background_secs" => out.background_secs = num,
            "clipboard_clear_secs" => out.clipboard_clear_secs = num,
            "reveal_secs" => out.reveal_secs = num,
            _ => {}
        }
    }
    if out.clipboard_clear_secs == 0 {
        out.clipboard_clear_secs = 30;
    }
    if out.reveal_secs == 0 {
        out.reveal_secs = 30;
    }
    Ok(out)
}

fn load_index(
    state: &VaultState,
    dek: &[u8; 32],
    salt: &[u8; 16],
    dek_ver: u32,
) -> Result<(VaultIndex, LockSettings), VaultError> {
    let (records, usage_rows, categories, tags) = state.with_store(|s| {
        Ok::<_, VaultError>((
            s.read_all_records()?,
            s.load_usage()?,
            s.load_categories()?,
            s.load_tags()?,
        ))
    })?;
    let mut index = VaultIndex::default();
    let mut rows = Vec::new();
    for rec in &records {
        if rec.tombstone != 0 {
            continue;
        }
        rows.push(decrypt_meta(dek, salt, rec)?);
    }
    let mut usage = HashMap::new();
    for row in &usage_rows {
        let rk = kdf::derive_record_key(dek, salt, &row.record_id, "usage", row.dek_ver)?;
        let aad = format!("tduse|{}|v{}", row.record_id, row.dek_ver);
        if let Ok(plain) = aead::open(&rk, &row.nonce, &row.ciphertext, &aad) {
            if let Ok(u) = serde_json::from_slice::<UsageData>(&plain) {
                usage.insert(row.record_id.clone(), u.last_used_at);
            }
        }
    }
    for row in &categories {
        let rk = kdf::derive_record_key(dek, salt, &row.id, "category", row.dek_ver)?;
        let aad = format!("tdcat|{}|v{}", row.id, row.dek_ver);
        if let Ok(plain) = aead::open(&rk, &row.nonce, &row.ciphertext, &aad) {
            if let Ok(name) = std::str::from_utf8(&plain) {
                index
                    .category_names
                    .insert(row.id.clone(), name.to_string());
            }
        }
    }
    for row in &tags {
        let rk = kdf::derive_record_key(dek, salt, &row.id, "tag", row.dek_ver)?;
        let aad = format!("tdtag|{}|v{}", row.id, row.dek_ver);
        if let Ok(plain) = aead::open(&rk, &row.nonce, &row.ciphertext, &aad) {
            if let Ok(name) = std::str::from_utf8(&plain) {
                index.tag_names.insert(row.id.clone(), name.to_string());
            }
        }
    }
    index.rebuild(rows);
    index.usage = usage;
    let settings = state.with_store(|s| load_settings(s, dek, salt, dek_ver))?;
    Ok((index, settings))
}

fn mark_used_inner(state: &VaultState, id: &str) -> Result<(), VaultError> {
    let (dek, salt, dek_ver) = {
        let s = state.session.read();
        if !s.is_unlocked() {
            return Err(VaultError::locked());
        }
        (
            s.dek_copy().ok_or_else(VaultError::locked)?,
            s.vault_salt,
            s.dek_ver,
        )
    };
    let rec = state
        .with_store(|s| s.get_record(id))?
        .ok_or_else(VaultError::not_found)?;
    let now = now_iso();
    let rk = kdf::derive_record_key(&dek, &salt, id, "usage", dek_ver)?;
    let aad = format!("tduse|{id}|v{dek_ver}");
    let usage = UsageData {
        last_used_at: now.clone(),
        use_count: 1,
    };
    let sealed = aead::seal(&rk, serde_json::to_string(&usage)?.as_bytes(), &aad)?;
    state.with_store(|s| {
        s.put_usage(&StoredUsage {
            record_id: id.to_string(),
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            alg_ver: ALG_VERSION,
            dek_ver,
        })
    })?;
    let _ = rec;
    if let Some(mut s) = state.session.try_write() {
        s.index.usage.insert(id.to_string(), now);
    }
    Ok(())
}

fn clear_clipboard_if_unchanged(
    state: &VaultState,
    token: &str,
) -> Result<ClearResultDto, VaultError> {
    let pending = {
        let s = state.session.read();
        match s.pending_copy.as_ref() {
            Some(p) if p.token == token => p.clone(),
            _ => {
                return Ok(ClearResultDto {
                    cleared: false,
                    reason: "superseded".to_string(),
                })
            }
        }
    };
    let rt =
        clipboard_runtime(&state.app).ok_or_else(|| VaultError::io("clipboard:unavailable"))?;
    let read = platform::read_clipboard(true);
    let text = match read {
        platform::ClipboardRead::Content { content, .. }
            if content.kind == crate::clipboard::KIND_TEXT =>
        {
            content.text.clone()
        }
        platform::ClipboardRead::Empty(_) => {
            state.session.write().pending_copy = None;
            return Ok(ClearResultDto {
                cleared: true,
                reason: "already_empty".to_string(),
            });
        }
        _ => {
            return Ok(ClearResultDto {
                cleared: false,
                reason: "unavailable".to_string(),
            })
        }
    };
    if sha256(text.as_bytes()) != pending.digest {
        state.session.write().pending_copy = None;
        return Ok(ClearResultDto {
            cleared: false,
            reason: "changed_by_user".to_string(),
        });
    }
    let current = ClipboardPayload::Text { text, html: None };
    let empty = ClipboardPayload::Text {
        text: String::new(),
        html: None,
    };
    match platform::write_guarded_notifying(&empty, WriteGuard::Content(&current), &rt.self_write) {
        Ok(WriteOutcome::Written { .. }) => {
            state.session.write().pending_copy = None;
            let _ = state.with_store(|s| s.audit("clipboard_clear", "ok", None, None));
            Ok(ClearResultDto {
                cleared: true,
                reason: "cleared".to_string(),
            })
        }
        Ok(WriteOutcome::SequenceChanged) | Ok(WriteOutcome::Unverifiable) => {
            state.session.write().pending_copy = None;
            Ok(ClearResultDto {
                cleared: false,
                reason: "changed_before_clear".to_string(),
            })
        }
        Err(_) => Ok(ClearResultDto {
            cleared: false,
            reason: "write_failed".to_string(),
        }),
    }
}

fn write_crash_marker(state: &VaultState, vault_id: &str) {
    let path = state.data_dir.join(crate::secure_vault::SESSION_MARKER);
    let body = serde_json::json!({
        "vaultId": vault_id,
        "pid": std::process::id(),
        "at": now_iso(),
    });
    let _ = std::fs::write(path, body.to_string());
}

fn remove_crash_marker(state: &VaultState) {
    let _ = std::fs::remove_file(state.data_dir.join(crate::secure_vault::SESSION_MARKER));
}

impl VaultIndex {
    /// 浅拷贝（只用于组装 DTO，不复制 DEK）。
    fn clone_shallow(&self) -> VaultIndex {
        VaultIndex {
            rows: self.rows.clone(),
            by_id: self.by_id.clone(),
            usage: self.usage.clone(),
            tag_names: self.tag_names.clone(),
            category_names: self.category_names.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, title: &str) -> RecordMeta {
        RecordMeta {
            id: id.to_string(),
            rev: 1,
            field_count: 2,
            record_type: "password".to_string(),
            title: title.to_string(),
            username: "alice@example.com".to_string(),
            email: "alice@example.com".to_string(),
            url: "https://example.com/login".to_string(),
            platform: "example".to_string(),
            category_id: String::new(),
            tag_ids: Vec::new(),
            favorite: false,
            note: "backup email: alice-backup@example.com".to_string(),
            created_at: "2026-11-18T00:00:00Z".to_string(),
            updated_at: "2026-11-18T00:00:00Z".to_string(),
        }
    }

    fn secret() -> RecordSecret {
        RecordSecret {
            version: DATA_VERSION,
            fields: vec![
                SecretField {
                    id: "username".to_string(),
                    label: "用户名".to_string(),
                    kind: "text".to_string(),
                    encoding: "utf8".to_string(),
                    value: "alice".to_string(),
                },
                SecretField {
                    id: "password".to_string(),
                    label: "密码".to_string(),
                    kind: "password".to_string(),
                    encoding: "utf8".to_string(),
                    value: "correct horse battery staple".to_string(),
                },
            ],
        }
    }

    fn seal(dek: &[u8; 32], salt: &[u8; 16], id: &str) -> StoredRecord {
        let (meta_nonce, meta_ct) =
            encrypt_meta(dek, salt, id, 1, &meta(id, "邮箱主账号")).unwrap();
        let (secret_nonce, secret_ct) = encrypt_secret(dek, salt, id, 1, &secret()).unwrap();
        StoredRecord {
            id: id.to_string(),
            rev: 1,
            dek_ver: 1,
            alg_ver: ALG_VERSION,
            data_ver: DATA_VERSION,
            meta_nonce,
            meta_ct,
            secret_nonce,
            secret_ct,
            tombstone: 0,
        }
    }

    #[test]
    fn record_roundtrip_keeps_multiline_and_unicode_secrets() {
        let dek = [9u8; 32];
        let salt = [3u8; 16];
        let rec = seal(&dek, &salt, "rec-1");
        let opened = decrypt_meta(&dek, &salt, &rec).unwrap();
        assert_eq!(opened.title, "邮箱主账号");
        assert_eq!(opened.email, "alice@example.com");
        let opened_secret = decrypt_secret(&dek, &salt, &rec).unwrap();
        assert_eq!(opened_secret.fields.len(), 2);
        assert_eq!(
            opened_secret.fields[1].value,
            "correct horse battery staple"
        );
    }

    #[test]
    fn same_plaintext_uses_fresh_nonce_and_ciphertext() {
        let dek = [7u8; 32];
        let salt = [5u8; 16];
        let a = seal(&dek, &salt, "rec-a");
        let b = seal(&dek, &salt, "rec-b");
        assert_ne!(a.secret_nonce, b.secret_nonce);
        assert_ne!(a.secret_ct, b.secret_ct);
    }

    #[test]
    fn tampered_ciphertext_and_cross_record_aad_are_rejected() {
        let dek = [11u8; 32];
        let salt = [13u8; 16];
        let rec = seal(&dek, &salt, "rec-a");
        let mut tampered = rec.clone();
        tampered.secret_ct[0] ^= 0x01;
        assert!(decrypt_secret(&dek, &salt, &tampered).is_err());

        let mut swapped = rec.clone();
        swapped.id = "rec-b".to_string();
        assert!(decrypt_meta(&dek, &salt, &swapped).is_err());
        assert!(decrypt_secret(&dek, &salt, &swapped).is_err());
    }

    #[test]
    fn wrong_key_and_wrong_salt_are_rejected() {
        let dek = [21u8; 32];
        let salt = [23u8; 16];
        let rec = seal(&dek, &salt, "rec-c");
        assert!(decrypt_meta(&[22u8; 32], &salt, &rec).is_err());
        assert!(decrypt_secret(&dek, &[24u8; 16], &rec).is_err());
    }
}
