//! 备份 bundle 剪贴板段的密钥信封：独立 BEK + 口令（Argon2id）/ 恢复密钥（HKDF）双 slot。
//!
//! 设计边界（与 `docs/adr/0012-clipboard-static-encryption.md` §8 一致）：
//! - 每次备份生成**独立随机 BEK**，不复用剪贴板 CEK，也不复用保险箱 DEK/KEK；
//! - BEK 只用口令或恢复密钥封装；两者派生域互不相同（HKDF info 分离），
//!   因此在同一份信封里任一 slot 可解出同一 BEK，便于"忘记口令仍可用密钥恢复"；
//! - 口令派生使用 Argon2id，参数随信封持久化，升级基线不会改变旧信封语义；
//! - 恢复密钥为 160-bit 随机，按 Crockford Base32 展示，只做 HKDF 域分离；
//! - 段落密文使用 AES-256-GCM 并绑定 AAD（`tdclbk|<backup_id>|<section>|v1`），
//!   同一 BEK 下不同段落/不同备份的密文不可互换；
//! - 明文 BEK 只存在于 `Zeroizing` 内存。
//!
//! 本模块只提供信封与段落加解密原语；bundle 写入/恢复链路接入见 ADR §14 批次 4b。

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::secure_vault::crypto::kdf::{self, Argon2Params};
use crate::secure_vault::crypto::secret_bytes;

pub const ENVELOPE_FORMAT: &str = "tdclbk-key-envelope";
pub const ENVELOPE_VERSION: u32 = 1;
/// 口令最短长度（字符数）。恢复密钥不适用。
pub const MIN_PASSPHRASE_CHARS: usize = 8;
/// 剪贴板段在 bundle 中的段名。
pub const SECTION_CLIPBOARD: &str = "clipboard";

const SLOT_PASSWORD: &str = "password";
const SLOT_RECOVERY: &str = "recovery";
const INFO_PASSWORD: &str = "taskdock-clipboard/kek/backup-password/v1";
const INFO_RECOVERY: &str = "taskdock-clipboard/kek/backup-recovery/v1";
const ALG_ARGON2ID: &str = "argon2id";
const ALG_HKDF: &str = "hkdf-sha256";
const ALG_AES_GCM: &str = "aes-256-gcm";

/// KDF 参数随 slot 持久化，便于未来升级基线而不影响旧备份。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotKdf {
    pub alg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salt_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub m_cost_kib: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t_cost: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p_cost: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotWrap {
    pub alg: String,
    pub nonce_b64: String,
    pub ct_b64: String,
    pub aad: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySlot {
    pub kdf: SlotKdf,
    pub wrap: SlotWrap,
}

/// 备份密钥信封：只存封装态 BEK 与参数，不含明文密钥。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupKeyEnvelope {
    pub format: String,
    pub version: u32,
    pub backup_id: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<KeySlot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<KeySlot>,
}

impl BackupKeyEnvelope {
    pub fn has_password(&self) -> bool {
        self.password.is_some()
    }

    pub fn has_recovery(&self) -> bool {
        self.recovery.is_some()
    }

    /// 校验信封结构与算法标识；未知格式/版本一律报错，不回退明文。
    pub fn validate(&self) -> AppResult<()> {
        if self.format != ENVELOPE_FORMAT {
            return Err(AppError::Validation("备份密钥信封格式不受支持".into()));
        }
        if self.version == 0 || self.version > ENVELOPE_VERSION {
            return Err(AppError::Validation(format!(
                "备份密钥信封版本不受支持: {}",
                self.version
            )));
        }
        if self.password.is_none() && self.recovery.is_none() {
            return Err(AppError::Validation("备份密钥信封缺少可用 slot".into()));
        }
        if let Some(slot) = &self.password {
            check_slot(slot, ALG_ARGON2ID, true)?;
        }
        if let Some(slot) = &self.recovery {
            check_slot(slot, ALG_HKDF, false)?;
        }
        Ok(())
    }
}

fn check_slot(slot: &KeySlot, kdf_alg: &str, need_salt: bool) -> AppResult<()> {
    if slot.kdf.alg != kdf_alg || slot.wrap.alg != ALG_AES_GCM {
        return Err(AppError::Validation(
            "备份密钥信封槽位算法不受支持".into(),
        ));
    }
    if need_salt && slot.kdf.salt_b64.is_none() {
        return Err(AppError::Validation("备份口令槽位缺少盐值".into()));
    }
    Ok(())
}

/// 新建信封的结果：信封本身、明文 BEK、可选恢复密钥文本（仅展示一次）。
pub struct CreatedEnvelope {
    pub envelope: BackupKeyEnvelope,
    pub bek: Zeroizing<[u8; 32]>,
    pub recovery_code: Option<String>,
}

/// 备份段落密文：nonce 与密文分开存放，AAD 一并持久化以便审计。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedSection {
    pub alg: String,
    pub nonce_b64: String,
    pub ct_b64: String,
    pub aad: String,
}

/// 段落 AAD：同一 BEK 下不同备份、不同段落不可互换。
pub fn section_aad(backup_id: &str, section: &str) -> String {
    format!("tdclbk|{backup_id}|{section}|v1")
}

fn slot_aad(backup_id: &str, slot: &str) -> String {
    format!("tdclbk|{backup_id}|slot|{slot}|v1")
}

/// 信封里记录的 AAD 必须与当前 `backup_id`/slot 推导值一致，
/// 否则按"备份被拼接到别的信封"处理，避免 AAD 字段被替换绕过绑定。
fn check_slot_aad(envelope: &BackupKeyEnvelope, slot: &KeySlot, name: &str) -> AppResult<()> {
    if slot.wrap.aad != slot_aad(&envelope.backup_id, name) {
        return Err(AppError::Validation("备份密钥信封 AAD 不匹配".into()));
    }
    Ok(())
}

fn rng_array<const N: usize>() -> AppResult<[u8; N]> {
    let mut out = [0u8; N];
    OsRng
        .try_fill_bytes(&mut out)
        .map_err(|e| AppError::Unavailable(format!("备份密钥随机数不可用: {e}")))?;
    Ok(out)
}

fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64_decode(raw: &str) -> AppResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|_| AppError::Validation("备份密文编码损坏".into()))
}

fn cipher(key: &[u8; 32]) -> AppResult<Aes256Gcm> {
    Aes256Gcm::new_from_slice(key).map_err(|_| AppError::Unavailable("备份密钥不可用".into()))
}

fn seal_with(key: &[u8; 32], aad: &str, plaintext: &[u8]) -> AppResult<(String, String)> {
    let nonce_bytes: [u8; 12] = rng_array()?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher(key)?
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| AppError::Unavailable("备份加密失败".into()))?;
    Ok((b64_encode(&nonce_bytes), b64_encode(&ct)))
}

fn open_with(key: &[u8; 32], nonce_b64: &str, ct_b64: &str, aad: &str) -> AppResult<Vec<u8>> {
    let nonce_bytes = b64_decode(nonce_b64)?;
    if nonce_bytes.len() != 12 {
        return Err(AppError::Validation("备份密文 nonce 长度异常".into()));
    }
    let ct = b64_decode(ct_b64)?;
    cipher(key)?
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &ct,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| AppError::Validation("备份密钥不正确或备份已损坏".into()))
}

fn password_kek(
    passphrase: &str,
    salt: &[u8; 16],
    params: &Argon2Params,
) -> AppResult<Zeroizing<[u8; 32]>> {
    params.validate().map_err(|_| {
        AppError::Validation("备份口令 KDF 参数超出范围".into())
    })?;
    let normalized = Zeroizing::new(kdf::normalize_password(passphrase));
    if normalized.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(AppError::Validation(format!(
            "备份口令至少 {MIN_PASSPHRASE_CHARS} 个字符"
        )));
    }
    let p = Params::new(params.m_cost_kib, params.t_cost, params.p_cost, Some(32))
        .map_err(|e| AppError::Validation(format!("备份口令 KDF 参数非法: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
    let mut master = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(normalized.as_bytes(), salt, &mut master[..])
        .map_err(|e| AppError::Validation(format!("备份口令派生失败: {e}")))?;
    let hk = Hkdf::<Sha256>::new(None, &master[..]);
    let mut kek = Zeroizing::new([0u8; 32]);
    hk.expand(INFO_PASSWORD.as_bytes(), &mut kek[..])
        .map_err(|e| AppError::Validation(format!("备份口令派生失败: {e}")))?;
    Ok(kek)
}

fn recovery_kek(bytes: &[u8; 20]) -> AppResult<Zeroizing<[u8; 32]>> {
    let hk = Hkdf::<Sha256>::new(None, &bytes[..]);
    let mut kek = Zeroizing::new([0u8; 32]);
    hk.expand(INFO_RECOVERY.as_bytes(), &mut kek[..])
        .map_err(|e| AppError::Validation(format!("备份恢复密钥派生失败: {e}")))?;
    Ok(kek)
}

fn make_password_slot(
    passphrase: &str,
    backup_id: &str,
    params: &Argon2Params,
    bek: &[u8; 32],
) -> AppResult<KeySlot> {
    let salt: [u8; 16] = rng_array()?;
    let kek = password_kek(passphrase, &salt, params)?;
    let aad = slot_aad(backup_id, SLOT_PASSWORD);
    let (nonce_b64, ct_b64) = seal_with(&kek, &aad, bek)?;
    Ok(KeySlot {
        kdf: SlotKdf {
            alg: ALG_ARGON2ID.into(),
            salt_b64: Some(b64_encode(&salt)),
            m_cost_kib: Some(params.m_cost_kib),
            t_cost: Some(params.t_cost),
            p_cost: Some(params.p_cost),
        },
        wrap: SlotWrap {
            alg: ALG_AES_GCM.into(),
            nonce_b64,
            ct_b64,
            aad,
        },
    })
}

fn make_recovery_slot(bytes: &[u8; 20], backup_id: &str, bek: &[u8; 32]) -> AppResult<KeySlot> {
    let kek = recovery_kek(bytes)?;
    let aad = slot_aad(backup_id, SLOT_RECOVERY);
    let (nonce_b64, ct_b64) = seal_with(&kek, &aad, bek)?;
    Ok(KeySlot {
        kdf: SlotKdf {
            alg: ALG_HKDF.into(),
            salt_b64: None,
            m_cost_kib: None,
            t_cost: None,
            p_cost: None,
        },
        wrap: SlotWrap {
            alg: ALG_AES_GCM.into(),
            nonce_b64,
            ct_b64,
            aad,
        },
    })
}

fn create_inner(
    passphrase: Option<&str>,
    with_recovery: bool,
    params: &Argon2Params,
) -> AppResult<CreatedEnvelope> {
    if passphrase.is_none() && !with_recovery {
        return Err(AppError::Validation(
            "至少需要备份口令或恢复密钥之一".into(),
        ));
    }
    let backup_id = uuid::Uuid::new_v4().to_string();
    let bek: Zeroizing<[u8; 32]> = Zeroizing::new(rng_array::<32>()?);
    let password = match passphrase {
        Some(pass) => Some(make_password_slot(pass, &backup_id, params, &bek)?),
        None => None,
    };
    let (recovery, recovery_code) = if with_recovery {
        let bytes: [u8; 20] = rng_array()?;
        let slot = make_recovery_slot(&bytes, &backup_id, &bek)?;
        (Some(slot), Some(secret_bytes::encode_recovery(&bytes)))
    } else {
        (None, None)
    };
    Ok(CreatedEnvelope {
        envelope: BackupKeyEnvelope {
            format: ENVELOPE_FORMAT.into(),
            version: ENVELOPE_VERSION,
            backup_id,
            created_at: chrono::Utc::now().to_rfc3339(),
            password,
            recovery,
        },
        bek,
        recovery_code,
    })
}

/// 生成新信封与 BEK。`with_recovery` 为真时同时产出仅展示一次的恢复密钥文本。
pub fn create(passphrase: Option<&str>, with_recovery: bool) -> AppResult<CreatedEnvelope> {
    create_inner(passphrase, with_recovery, &Argon2Params::baseline())
}

#[cfg(test)]
fn create_fast(passphrase: Option<&str>, with_recovery: bool) -> AppResult<CreatedEnvelope> {
    create_inner(
        passphrase,
        with_recovery,
        &Argon2Params {
            m_cost_kib: 8192,
            t_cost: 1,
            p_cost: 1,
        },
    )
}

/// 用口令解出 BEK。
pub fn unwrap_with_password(
    envelope: &BackupKeyEnvelope,
    passphrase: &str,
) -> AppResult<Zeroizing<[u8; 32]>> {
    envelope.validate()?;
    let slot = envelope
        .password
        .as_ref()
        .ok_or_else(|| AppError::Validation("备份未设置口令槽位".into()))?;
    check_slot_aad(envelope, slot, SLOT_PASSWORD)?;
    let salt_b64 = slot
        .kdf
        .salt_b64
        .as_ref()
        .ok_or_else(|| AppError::Validation("备份口令槽位缺少盐值".into()))?;
    let salt_bytes = b64_decode(salt_b64)?;
    if salt_bytes.len() != 16 {
        return Err(AppError::Validation("备份口令盐值长度异常".into()));
    }
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&salt_bytes);
    let params = Argon2Params {
        m_cost_kib: slot.kdf.m_cost_kib.ok_or_else(|| {
            AppError::Validation("备份口令槽位缺少 KDF 参数".into())
        })?,
        t_cost: slot
            .kdf
            .t_cost
            .ok_or_else(|| AppError::Validation("备份口令槽位缺少 KDF 参数".into()))?,
        p_cost: slot
            .kdf
            .p_cost
            .ok_or_else(|| AppError::Validation("备份口令槽位缺少 KDF 参数".into()))?,
    };
    let kek = password_kek(passphrase, &salt, &params)?;
    let plain = open_with(&kek, &slot.wrap.nonce_b64, &slot.wrap.ct_b64, &slot.wrap.aad)?;
    if plain.len() != 32 {
        return Err(AppError::Validation("备份密钥长度异常".into()));
    }
    let mut bek = Zeroizing::new([0u8; 32]);
    bek.copy_from_slice(&plain);
    Ok(bek)
}

/// 用恢复密钥文本解出 BEK（忽略分隔符与易混字符）。
pub fn unwrap_with_recovery(
    envelope: &BackupKeyEnvelope,
    recovery_code: &str,
) -> AppResult<Zeroizing<[u8; 32]>> {
    envelope.validate()?;
    let slot = envelope
        .recovery
        .as_ref()
        .ok_or_else(|| AppError::Validation("备份未设置恢复密钥槽位".into()))?;
    check_slot_aad(envelope, slot, SLOT_RECOVERY)?;
    let bytes = secret_bytes::parse_recovery(recovery_code)
        .map_err(|_| AppError::Validation("恢复密钥格式不正确".into()))?;
    let kek = recovery_kek(&bytes)?;
    let plain = open_with(&kek, &slot.wrap.nonce_b64, &slot.wrap.ct_b64, &slot.wrap.aad)?;
    if plain.len() != 32 {
        return Err(AppError::Validation("备份密钥长度异常".into()));
    }
    let mut bek = Zeroizing::new([0u8; 32]);
    bek.copy_from_slice(&plain);
    Ok(bek)
}

/// 加密一个 bundle 段落。
pub fn seal_section(bek: &[u8; 32], aad: &str, plaintext: &[u8]) -> AppResult<SealedSection> {
    let (nonce_b64, ct_b64) = seal_with(bek, aad, plaintext)?;
    Ok(SealedSection {
        alg: ALG_AES_GCM.into(),
        nonce_b64,
        ct_b64,
        aad: aad.to_string(),
    })
}

/// 解密一个 bundle 段落；解密失败一律按"密钥错误或数据损坏"报错，不透出内容。
pub fn open_section(
    bek: &[u8; 32],
    aad: &str,
    sealed: &SealedSection,
) -> AppResult<Zeroizing<Vec<u8>>> {
    if sealed.alg != ALG_AES_GCM {
        return Err(AppError::Validation("备份段落算法不受支持".into()));
    }
    if sealed.aad != aad {
        return Err(AppError::Validation("备份段落 AAD 不匹配".into()));
    }
    let plain = open_with(bek, &sealed.nonce_b64, &sealed.ct_b64, aad)?;
    Ok(Zeroizing::new(plain))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASS: &str = "correct horse battery";

    #[test]
    fn password_slot_roundtrip_and_wrong_password_rejected() {
        let created = create_fast(Some(PASS), false).unwrap();
        let bek = unwrap_with_password(&created.envelope, PASS).unwrap();
        assert_eq!(bek[..], created.bek[..]);
        assert!(unwrap_with_password(&created.envelope, "wrong passphrase").is_err());
        assert!(!created.envelope.has_recovery());
        assert!(created.recovery_code.is_none());
    }

    #[test]
    fn recovery_slot_opens_same_bek_and_rejects_other_code() {
        let created = create_fast(None, true).unwrap();
        let code = created.recovery_code.clone().unwrap();
        let bek = unwrap_with_recovery(&created.envelope, &code).unwrap();
        assert_eq!(bek[..], created.bek[..]);
        let other = create_fast(None, true).unwrap().recovery_code.unwrap();
        assert!(unwrap_with_recovery(&created.envelope, &other).is_err());
        assert!(unwrap_with_password(&created.envelope, PASS).is_err());
    }

    #[test]
    fn dual_slots_yield_identical_bek() {
        let created = create_fast(Some(PASS), true).unwrap();
        let code = created.recovery_code.clone().unwrap();
        let a = unwrap_with_password(&created.envelope, PASS).unwrap();
        let b = unwrap_with_recovery(&created.envelope, &code).unwrap();
        assert_eq!(a[..], b[..]);
    }

    #[test]
    fn tampered_envelope_is_rejected() {
        let created = create_fast(Some(PASS), false).unwrap();
        let mut env = created.envelope.clone();
        let slot = env.password.as_mut().unwrap();
        slot.wrap.ct_b64 = slot.wrap.ct_b64.chars().rev().collect();
        assert!(unwrap_with_password(&env, PASS).is_err());

        let mut env2 = created.envelope.clone();
        env2.backup_id = "other-backup".into();
        assert!(unwrap_with_password(&env2, PASS).is_err());
    }

    #[test]
    fn envelope_validation_catches_bad_shapes() {
        let created = create_fast(Some(PASS), false).unwrap();
        let mut env = created.envelope.clone();
        env.format = "tdclbk-v0".into();
        assert!(env.validate().is_err());

        let mut env2 = BackupKeyEnvelope {
            format: ENVELOPE_FORMAT.into(),
            version: ENVELOPE_VERSION,
            backup_id: "b".into(),
            created_at: "t".into(),
            password: None,
            recovery: None,
        };
        assert!(env2.validate().is_err());
        env2.version = ENVELOPE_VERSION + 1;
        assert!(env2.validate().is_err());
        assert!(create_fast(None, false).is_err());
        assert!(create_fast(Some("short"), false).is_err());
    }

    #[test]
    fn section_roundtrip_binds_aad() {
        let created = create_fast(Some(PASS), false).unwrap();
        let aad = section_aad(&created.envelope.backup_id, SECTION_CLIPBOARD);
        let plain = b"hello clipboard".to_vec();
        let sealed = seal_section(&created.bek, &aad, &plain).unwrap();
        let opened = open_section(&created.bek, &aad, &sealed).unwrap();
        assert_eq!(opened.to_vec(), plain);

        let other_aad = section_aad(&created.envelope.backup_id, "tasks");
        assert!(open_section(&created.bek, &other_aad, &sealed).is_err());
        let other = create_fast(Some(PASS), false).unwrap();
        assert!(open_section(&other.bek, &aad, &sealed).is_err());
    }
}
