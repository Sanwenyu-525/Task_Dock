//! 主密码 / 恢复密钥 / 记录子密钥的派生。
//!
//! 参数随信封持久化（`Argon2Params`），因此升级基线不会改变旧信封语义。

use super::{INFO_DIGEST, INFO_KEK_BACKUP, INFO_KEK_MASTER, INFO_KEK_RECOVERY};
use crate::secure_vault::crypto::record_info;
use crate::secure_vault::error::VaultError;
use argon2::{Algorithm, Argon2, Params, Version};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Argon2Params {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl Default for Argon2Params {
    fn default() -> Self {
        Self::baseline()
    }
}

impl Argon2Params {
    pub const fn baseline() -> Self {
        Self {
            m_cost_kib: 65536,
            t_cost: 3,
            p_cost: 1,
        }
    }

    pub fn validate(&self) -> Result<(), VaultError> {
        if self.m_cost_kib < 8192 || self.m_cost_kib > 1048576 {
            return Err(VaultError::validation("KDF 内存参数", "须在 8 MiB–1 GiB 之间"));
        }
        if self.t_cost < 1 || self.t_cost > 16 {
            return Err(VaultError::validation("KDF 迭代参数", "须在 1–16 之间"));
        }
        if self.p_cost < 1 || self.p_cost > 16 {
            return Err(VaultError::validation("KDF 并行参数", "须在 1–16 之间"));
        }
        Ok(())
    }
}

/// 口令规范化：NFKC + 去掉首尾空白。不做大小写折叠（口令应区分大小写）。
pub fn normalize_password(raw: &str) -> String {
    raw.nfkc().collect::<String>().trim().to_string()
}

pub fn derive_master_kek(
    password: &str,
    salt: &[u8; 16],
    params: &Argon2Params,
) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    params.validate()?;
    let normalized = Zeroizing::new(normalize_password(password));
    if normalized.is_empty() {
        return Err(VaultError::validation("主密码", "不能为空"));
    }
    let p = Params::new(params.m_cost_kib, params.t_cost, params.p_cost, Some(32))
        .map_err(|e| VaultError::kdf_failed(format!("params:{e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
    let mut master = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(normalized.as_bytes(), salt, &mut master[..])
        .map_err(|e| VaultError::kdf_failed(format!("argon2:{e}")))?;
    hkdf_expand(&master[..], None, INFO_KEK_MASTER)
}

/// 恢复密钥已是 160-bit 随机，无需 Argon2；HKDF 只做域分离。
pub fn derive_recovery_kek(bytes: &[u8; 20]) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    hkdf_expand(bytes, None, INFO_KEK_RECOVERY)
}

/// 备份口令：与主密码同参数，但派生域不同（`INFO_KEK_BACKUP`）。
pub fn derive_backup_kek(
    passphrase: &str,
    salt: &[u8; 16],
    params: &Argon2Params,
) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let master = derive_master_kek(passphrase, salt, params)?;
    hkdf_expand(&master[..], None, INFO_KEK_BACKUP)
}

pub fn derive_record_key(
    dek: &[u8; 32],
    vault_salt: &[u8; 16],
    id: &str,
    purpose: &str,
    dek_ver: u32,
) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let info = record_info(id, purpose, dek_ver);
    hkdf_expand(dek, Some(vault_salt), &info)
}

pub fn derive_digest_key(
    dek: &[u8; 32],
    vault_salt: &[u8; 16],
) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    hkdf_expand(dek, Some(vault_salt), INFO_DIGEST)
}

fn hkdf_expand(
    ikm: &[u8],
    salt: Option<&[u8]>,
    info: &str,
) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let hk = Hkdf::<Sha256>::new(salt, ikm);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(info.as_bytes(), &mut out[..])
        .map_err(|e| VaultError::kdf_failed(format!("hkdf:{e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast() -> Argon2Params {
        Argon2Params {
            m_cost_kib: 8192,
            t_cost: 1,
            p_cost: 1,
        }
    }

    #[test]
    fn normalize_handles_fullwidth_and_trim() {
        assert_eq!(normalize_password("  ｐａｓｓ  "), "pass");
        assert_eq!(normalize_password("Pass"), "Pass");
    }

    #[test]
    fn master_kek_is_deterministic_and_salt_sensitive() {
        let salt = [7u8; 16];
        let a = derive_master_kek("correct horse", &salt, &fast()).unwrap();
        let b = derive_master_kek("correct horse", &salt, &fast()).unwrap();
        assert_eq!(a[..], b[..]);
        let c = derive_master_kek("correct horse", &[9u8; 16], &fast()).unwrap();
        assert_ne!(a[..], c[..]);
    }

    #[test]
    fn record_keys_are_domain_separated() {
        let dek = [1u8; 32];
        let salt = [2u8; 16];
        let meta = derive_record_key(&dek, &salt, "r1", "meta", 1).unwrap();
        let secret = derive_record_key(&dek, &salt, "r1", "secret", 1).unwrap();
        let other = derive_record_key(&dek, &salt, "r2", "meta", 1).unwrap();
        assert_ne!(meta[..], secret[..]);
        assert_ne!(meta[..], other[..]);
    }
}
