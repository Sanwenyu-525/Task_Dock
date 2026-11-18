//! `.tdvault` 加密备份：导出、头部检查、导入到新库。
//!
//! 载荷是内存中的明文 JSON，落盘前整体加密；**不产生明文临时文件**。
//! P1 导入只支持"导入为新保险箱"（会要求先删除现有库），合并策略留待 P2。

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::secure_vault::crypto::aead;
use crate::secure_vault::crypto::envelope::{Envelope, KdfInfo, Wrap};
use crate::secure_vault::crypto::kdf::{self, Argon2Params};
use crate::secure_vault::crypto::secret_bytes;
use crate::secure_vault::crypto::{random_array, record_aad, sha256};
use crate::secure_vault::error::VaultError;
use crate::secure_vault::session::{
    LockSettings, RecordMeta, RecordSecret, RuntimeState, VaultIndex,
};
use crate::secure_vault::store::{
    Bootstrap, StoredName, StoredRecord, StoredUsage, VaultStore,
};
use crate::secure_vault::VaultState;

pub const BACKUP_FORMAT: &str = "tdv-vault-backup";
pub const BACKUP_VERSION: u32 = 1;
pub const BACKUP_AAD_HEADER: &str = "header";
pub const BACKUP_AAD_PAYLOAD: &str = "payload";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupHeader {
    pub format: String,
    pub version: u32,
    pub backup_id: String,
    pub vault_id: String,
    pub created_at: String,
    pub mode: String,
    pub record_count: usize,
    pub payload_len: u64,
    pub payload_sha256: String,
    pub kdf: KdfInfo,
    pub wrap: Wrap,
    pub payload_nonce_b64: String,
    pub payload_aad: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupPayload {
    v: u32,
    vault: BackupVaultInfo,
    categories: Vec<BackupName>,
    tags: Vec<BackupName>,
    records: Vec<BackupRecord>,
    settings: Option<LockSettings>,
    checksums: BackupChecksums,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupVaultInfo {
    schema_version: u32,
    vault_id: String,
    created_at: String,
    generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupName {
    id: String,
    name: String,
    #[serde(default)]
    sort_order: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRecord {
    id: String,
    rev: i64,
    meta: RecordMeta,
    secret: RecordSecret,
    usage: Option<BackupUsage>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupUsage {
    last_used_at: String,
    #[serde(default)]
    use_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupChecksums {
    count: usize,
    records_sha256: String,
}

fn aad(backup_id: &str, part: &str) -> String {
    format!("tdbkp|{backup_id}|{part}|v1")
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn validate_passphrase(p: &str) -> Result<(), VaultError> {
    let len = p.chars().count();
    if !(10..=128).contains(&len) {
        return Err(VaultError::validation("备份口令", "长度须在 10–128 字符之间"));
    }
    Ok(())
}

fn decrypt_record(
    dek: &[u8; 32],
    salt: &[u8; 16],
    rec: &StoredRecord,
) -> Result<(RecordMeta, RecordSecret), VaultError> {
    let mk = kdf::derive_record_key(dek, salt, &rec.id, "meta", rec.dek_ver)?;
    let meta_plain = aead::open(
        &mk,
        &rec.meta_nonce,
        &rec.meta_ct,
        &record_aad(&rec.id, "meta", rec.dek_ver, rec.data_ver),
    )?;
    let meta: RecordMeta = serde_json::from_slice(&meta_plain)
        .map_err(|_| VaultError::corrupt())?;
    let sk = kdf::derive_record_key(dek, salt, &rec.id, "secret", rec.dek_ver)?;
    let secret_plain = aead::open(
        &sk,
        &rec.secret_nonce,
        &rec.secret_ct,
        &record_aad(&rec.id, "secret", rec.dek_ver, rec.data_ver),
    )?;
    let secret: RecordSecret = serde_json::from_slice(&secret_plain)
        .map_err(|_| VaultError::corrupt())?;
    Ok((meta, secret))
}

fn decrypt_usage(
    dek: &[u8; 32],
    salt: &[u8; 16],
    row: &StoredUsage,
) -> Option<BackupUsage> {
    let rk = kdf::derive_record_key(dek, salt, &row.record_id, "usage", row.dek_ver).ok()?;
    let plain = aead::open(
        &rk,
        &row.nonce,
        &row.ciphertext,
        &format!("tduse|{}|v{}", row.record_id, row.dek_ver),
    )
    .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&plain).ok()?;
    Some(BackupUsage {
        last_used_at: v.get("lastUsedAt")?.as_str()?.to_string(),
        use_count: v.get("useCount").and_then(|x| x.as_i64()).unwrap_or(1),
    })
}

fn decrypt_name(dek: &[u8; 32], salt: &[u8; 16], row: &StoredName, kind: &str) -> Option<String> {
    let rk = kdf::derive_record_key(dek, salt, &row.id, kind, row.dek_ver).ok()?;
    let aad = if kind == "category" {
        format!("tdcat|{}|v{}", row.id, row.dek_ver)
    } else {
        format!("tdtag|{}|v{}", row.id, row.dek_ver)
    };
    let plain = aead::open(&rk, &row.nonce, &row.ciphertext, &aad).ok()?;
    Some(String::from_utf8(plain.to_vec()).ok()?)
}

fn seal_record(
    dek: &[u8; 32],
    salt: &[u8; 16],
    id: &str,
    rev: i64,
    dek_ver: u32,
    meta: &RecordMeta,
    secret: &RecordSecret,
) -> Result<StoredRecord, VaultError> {
    let mk = kdf::derive_record_key(dek, salt, id, "meta", dek_ver)?;
    let m = aead::seal(
        &mk,
        &serde_json::to_vec(meta)?,
        &record_aad(id, "meta", dek_ver, 1),
    )?;
    let sk = kdf::derive_record_key(dek, salt, id, "secret", dek_ver)?;
    let s = aead::seal(
        &sk,
        &serde_json::to_vec(secret)?,
        &record_aad(id, "secret", dek_ver, 1),
    )?;
    Ok(StoredRecord {
        id: id.to_string(),
        rev,
        dek_ver,
        alg_ver: 1,
        data_ver: 1,
        meta_nonce: m.nonce,
        meta_ct: m.ciphertext,
        secret_nonce: s.nonce,
        secret_ct: s.ciphertext,
        tombstone: 0,
    })
}

pub async fn export_backup(
    state: &VaultState,
    path: &str,
    passphrase: &str,
    include_settings: bool,
    overwrite: bool,
) -> Result<super::commands::BackupSummaryDto, VaultError> {
    validate_passphrase(passphrase)?;
    let (dek, salt, _dek_ver, vault_id, created_at, settings) = {
        let s = state.session.read();
        if s.runtime != RuntimeState::Unlocked {
            return Err(VaultError::locked());
        }
        (
            s.dek_copy().ok_or_else(VaultError::locked)?,
            s.vault_salt,
            s.dek_ver,
            s.vault_id.clone(),
            state.with_store(|st| st.get_meta("created_at"))?.unwrap_or_default(),
            s.lock_settings.clone(),
        )
    };

    let (records, usage, category_rows, tag_rows, generation) = state.with_store(|st| {
        Ok::<_, VaultError>((
            st.read_all_records()?,
            st.load_usage()?,
            st.load_categories()?,
            st.load_tags()?,
            st.get_meta("generation")?
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(1),
        ))
    })?;

    let mut out_records = Vec::new();
    let mut usage_map: HashMap<String, BackupUsage> = HashMap::new();
    for row in &usage {
        if let Some(u) = decrypt_usage(&dek, &salt, row) {
            usage_map.insert(row.record_id.clone(), u);
        }
    }
    for row in records.iter().filter(|r| r.tombstone == 0) {
        let (meta, secret) = decrypt_record(&dek, &salt, row)?;
        out_records.push(BackupRecord {
            id: row.id.clone(),
            rev: row.rev,
            usage: usage_map.remove(&row.id),
            meta,
            secret,
        });
    }
    let categories = category_rows
        .iter()
        .filter_map(|r| {
            decrypt_name(&dek, &salt, r, "category").map(|name| BackupName {
                id: r.id.clone(),
                name,
                sort_order: r.sort_order,
            })
        })
        .collect();
    let tags = tag_rows
        .iter()
        .filter_map(|r| {
            decrypt_name(&dek, &salt, r, "tag").map(|name| BackupName {
                id: r.id.clone(),
                name,
                sort_order: 0,
            })
        })
        .collect();

    let records_sha = {
        let mut acc = Vec::new();
        for r in &out_records {
            acc.extend_from_slice(r.id.as_bytes());
            acc.extend_from_slice(r.rev.to_string().as_bytes());
        }
        hex(&sha256(&acc))
    };
    let count = out_records.len();
    let payload = BackupPayload {
        v: 1,
        vault: BackupVaultInfo {
            schema_version: 1,
            vault_id: vault_id.clone(),
            created_at,
            generation,
        },
        categories,
        tags,
        records: out_records,
        settings: if include_settings { Some(settings) } else { None },
        checksums: BackupChecksums {
            count,
            records_sha256: records_sha,
        },
    };
    let payload_bytes = Zeroizing::new(serde_json::to_vec(&payload)?);
    let backup_id = uuid::Uuid::new_v4().to_string();
    let file_key: [u8; 32] = random_array()?;
    let payload_aad = aad(&backup_id, BACKUP_AAD_PAYLOAD);
    let sealed_payload = aead::seal(&file_key, &payload_bytes, &payload_aad)?;

    let kdf_salt: [u8; 16] = random_array()?;
    let params = Argon2Params::baseline();
    let pass = passphrase.to_string();
    let kek = tauri::async_runtime::spawn_blocking(move || {
        kdf::derive_backup_kek(&pass, &kdf_salt, &params)
    })
    .await
    .map_err(|_| VaultError::internal("join"))??;
    let header_aad = aad(&backup_id, BACKUP_AAD_HEADER);
    let wrap_sealed = aead::seal(&kek, &file_key, &header_aad)?;
    let header = BackupHeader {
        format: BACKUP_FORMAT.to_string(),
        version: BACKUP_VERSION,
        backup_id: backup_id.clone(),
        vault_id: vault_id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        mode: "full".to_string(),
        record_count: count,
        payload_len: sealed_payload.ciphertext.len() as u64,
        payload_sha256: hex(&sha256(&sealed_payload.ciphertext)),
        kdf: KdfInfo {
            alg: "argon2id".to_string(),
            lib_version: Some(19),
            m_cost_kib: Some(params.m_cost_kib),
            t_cost: Some(params.t_cost),
            p_cost: Some(params.p_cost),
            salt_b64: secret_bytes::b64_encode(&kdf_salt),
        },
        wrap: Wrap {
            alg: "aes-256-gcm".to_string(),
            nonce_b64: secret_bytes::b64_encode(&wrap_sealed.nonce),
            ct_b64: secret_bytes::b64_encode(&wrap_sealed.ciphertext),
            aad: header_aad,
        },
        payload_nonce_b64: secret_bytes::b64_encode(&sealed_payload.nonce),
        payload_aad,
    };

    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err(VaultError::validation("备份路径", "必须是绝对路径"));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
        let backups = state.data_dir.join("backups");
        if parent.starts_with(&backups) {
            return Err(VaultError::validation("备份路径", "不能写入主备份保留目录"));
        }
    }
    if target.exists() && !overwrite {
        return Err(VaultError::conflict(0, 0).with_detail("backup_exists"));
    }
    let body = serde_json::to_vec(&serde_json::json!({
        "header": header,
        "payloadCtB64": secret_bytes::b64_encode(&sealed_payload.ciphertext),
    }))?;
    let tmp = target.with_extension("tdvault.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&body)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &target)?;
    state.with_store(|s| s.audit("backup_export", "ok", None, Some(count as i64)))?;
    Ok(super::commands::BackupSummaryDto {
        path: target.to_string_lossy().to_string(),
        size: body.len() as u64,
        record_count: count,
        sha256: header.payload_sha256,
    })
}

pub fn inspect(path: &str) -> Result<BackupHeader, VaultError> {
    let raw = std::fs::read_to_string(path)?;
    let v: serde_json::Value = serde_json::from_str(&raw)?;
    let header: BackupHeader = serde_json::from_value(v.get("header").cloned().unwrap_or_default())
        .map_err(|_| VaultError::corrupt())?;
    if header.format != BACKUP_FORMAT {
        return Err(VaultError::corrupt());
    }
    if header.version > BACKUP_VERSION {
        return Err(VaultError::format_unsupported(header.version, BACKUP_VERSION));
    }
    Ok(header)
}

fn decrypt_payload(
    passphrase: &str,
    header: &BackupHeader,
    payload_ct: &[u8],
) -> Result<(BackupPayload, [u8; 32]), VaultError> {
    let mut payload = Vec::new();
    let kdf_salt = {
        let bytes = secret_bytes::b64_decode(&header.kdf.salt_b64)?;
        if bytes.len() != 16 {
            return Err(VaultError::corrupt());
        }
        let mut s = [0u8; 16];
        s.copy_from_slice(&bytes);
        s
    };
    payload.extend_from_slice(payload_ct);
    let params = Argon2Params {
        m_cost_kib: header.kdf.m_cost_kib.ok_or_else(VaultError::corrupt)?,
        t_cost: header.kdf.t_cost.ok_or_else(VaultError::corrupt)?,
        p_cost: header.kdf.p_cost.ok_or_else(VaultError::corrupt)?,
    };
    let kek = kdf::derive_backup_kek(passphrase, &kdf_salt, &params)?;
    let wrap_nonce = {
        let b = secret_bytes::b64_decode(&header.wrap.nonce_b64)?;
        if b.len() != 12 {
            return Err(VaultError::corrupt());
        }
        let mut n = [0u8; 12];
        n.copy_from_slice(&b);
        n
    };
    let wrap_ct = secret_bytes::b64_decode(&header.wrap.ct_b64)?;
    let file_key_plain = aead::open(&kek, &wrap_nonce, &wrap_ct, &header.wrap.aad)?;
    if file_key_plain.len() != 32 {
        return Err(VaultError::corrupt());
    }
    let mut file_key = [0u8; 32];
    file_key.copy_from_slice(&file_key_plain);
    let payload_nonce = {
        let b = secret_bytes::b64_decode(&header.payload_nonce_b64)?;
        if b.len() != 12 {
            return Err(VaultError::corrupt());
        }
        let mut n = [0u8; 12];
        n.copy_from_slice(&b);
        n
    };
    let plain = aead::open(&file_key, &payload_nonce, &payload, &header.payload_aad)?;
    let payload: BackupPayload =
        serde_json::from_slice(&plain).map_err(|_| VaultError::corrupt())?;
    Ok((payload, file_key))
}

pub async fn import_backup(
    state: &VaultState,
    path: &str,
    passphrase: &str,
    new_master_password: &str,
) -> Result<super::commands::ImportResultDto, VaultError> {
    if state.has_vault() {
        return Err(VaultError::already_exists()
            .with_detail("import_requires_empty_vault"));
    }
    if new_master_password.chars().count() < 8 {
        return Err(VaultError::validation("新主密码", "长度须在 8–128 字符之间"));
    }
    let header = inspect(path)?;
    let raw = std::fs::read_to_string(path)?;
    let v: serde_json::Value = serde_json::from_str(&raw)?;
    let payload_ct = secret_bytes::b64_decode(
        v.get("payloadCtB64")
            .and_then(|x| x.as_str())
            .ok_or_else(VaultError::corrupt)?,
    )?;
    if hex(&sha256(&payload_ct)) != header.payload_sha256 {
        return Err(VaultError::corrupt());
    }
    let pass = passphrase.to_string();
    let (payload, _file_key) = tauri::async_runtime::spawn_blocking(move || {
        decrypt_payload(&pass, &header, &payload_ct)
    })
    .await
    .map_err(|_| VaultError::internal("join"))??;
    if payload.v != 1 || payload.checksums.count != payload.records.len() {
        return Err(VaultError::corrupt());
    }

    let vault_id = uuid::Uuid::new_v4().to_string();
    let vault_salt: [u8; 16] = random_array()?;
    let kdf_salt: [u8; 16] = random_array()?;
    let dek: Zeroizing<[u8; 32]> = Zeroizing::new(random_array()?);
    let recovery_bytes: [u8; 20] = random_array()?;
    let params = Argon2Params::baseline();
    let password = new_master_password.to_string();
    let master_kek = tauri::async_runtime::spawn_blocking(move || {
        kdf::derive_master_kek(&password, &kdf_salt, &params)
    })
    .await
    .map_err(|_| VaultError::internal("join"))??;
    let recovery_kek = kdf::derive_recovery_kek(&recovery_bytes)?;
    let master_wrap = super::crypto::envelope::wrap_dek(&master_kek, &dek, &vault_id, "master")?;
    let recovery_wrap =
        super::crypto::envelope::wrap_dek(&recovery_kek, &dek, &vault_id, "recovery")?;
    let created_at = chrono::Utc::now().to_rfc3339();
    let master_env = Envelope {
        format: super::crypto::ENVELOPE_FORMAT.to_string(),
        version: super::crypto::ENVELOPE_VERSION,
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
        format: super::crypto::ENVELOPE_FORMAT.to_string(),
        version: super::crypto::ENVELOPE_VERSION,
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

    let mut index = VaultIndex::default();
    for cat in &payload.categories {
        let rk = kdf::derive_record_key(&dek, &vault_salt, &cat.id, "category", 1)?;
        let sealed = aead::seal(&rk, cat.name.as_bytes(), &format!("tdcat|{}|v1", cat.id))?;
        store.put_category(&StoredName {
            id: cat.id.clone(),
            sort_order: cat.sort_order,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            dek_ver: 1,
        })?;
        index.category_names.insert(cat.id.clone(), cat.name.clone());
    }
    for tag in &payload.tags {
        let rk = kdf::derive_record_key(&dek, &vault_salt, &tag.id, "tag", 1)?;
        let sealed = aead::seal(&rk, tag.name.as_bytes(), &format!("tdtag|{}|v1", tag.id))?;
        store.put_tag(&StoredName {
            id: tag.id.clone(),
            sort_order: 0,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            dek_ver: 1,
        })?;
        index.tag_names.insert(tag.id.clone(), tag.name.clone());
    }

    let mut rev = 1i64;
    for rec in &payload.records {
        let mut meta = rec.meta.clone();
        meta.rev = rev;
        let stored = seal_record(&dek, &vault_salt, &rec.id, rev, 1, &meta, &rec.secret)?;
        store.write_record(&stored, rev + 1, &dek, &vault_salt)?;
        if let Some(u) = &rec.usage {
            let rk = kdf::derive_record_key(&dek, &vault_salt, &rec.id, "usage", 1)?;
            let usage = serde_json::json!({
                "lastUsedAt": u.last_used_at,
                "useCount": u.use_count,
            });
            let sealed = aead::seal(
                &rk,
                usage.to_string().as_bytes(),
                &format!("tduse|{}|v1", rec.id),
            )?;
            store.put_usage(&StoredUsage {
                record_id: rec.id.clone(),
                nonce: sealed.nonce,
                ciphertext: sealed.ciphertext,
                alg_ver: 1,
                dek_ver: 1,
            })?;
            index.usage.insert(rec.id.clone(), u.last_used_at.clone());
        }
        index.rows.push(meta);
        rev += 1;
    }
    let rows = index.rows.clone();
    index.rebuild(rows);

    let settings = payload.settings.clone().unwrap_or_default();
    super::commands::save_settings_public(&store, &dek, &vault_salt, 1, &settings)?;
    store.set_meta("generation", "1")?;
    store.audit("backup_import", "ok", None, Some(payload.records.len() as i64))?;
    state.insert_store(store);

    {
        let mut s = state.session.write();
        s.runtime = RuntimeState::Unlocked;
        s.dek = Some(Zeroizing::new(*dek));
        s.dek_ver = 1;
        s.vault_id = vault_id;
        s.vault_salt = vault_salt;
        s.index = index;
        s.lock_settings = settings;
        s.last_activity = Instant::now();
        s.background_since = None;
        s.last_lock_reason = None;
    }
    Ok(super::commands::ImportResultDto {
        imported: payload.records.len(),
        skipped: 0,
    })
}
