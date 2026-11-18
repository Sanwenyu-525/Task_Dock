//! 密码学原语。所有 `info` 字符串与 AAD 必须与
//! `docs/features/secure-vault/security-architecture.md` §4.2 / §6.3 逐字一致。

pub mod aead;
pub mod envelope;
pub mod kdf;
pub mod password_gen;
pub mod secret_bytes;

use crate::secure_vault::error::VaultError;
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};

pub const INFO_KEK_MASTER: &str = "taskdock-vault/kek/master/v1";
pub const INFO_KEK_RECOVERY: &str = "taskdock-vault/kek/recovery/v1";
pub const INFO_DIGEST: &str = "taskdock-vault/digest/v1";
pub const INFO_RECORD_META: &str = "taskdock-vault/record/{id}/meta/v{ver}";
pub const INFO_RECORD_SECRET: &str = "taskdock-vault/record/{id}/secret/v{ver}";
pub const INFO_KEK_BACKUP: &str = "taskdock-vault/kek/backup/v1";
pub const ENVELOPE_FORMAT: &str = "tdv-key-envelope";
pub const ENVELOPE_VERSION: u32 = 1;

pub fn random_array<const N: usize>() -> Result<[u8; N], VaultError> {
    let mut out = [0u8; N];
    OsRng
        .try_fill_bytes(&mut out)
        .map_err(|e| VaultError::internal(format!("rng:{}", e)))?;
    Ok(out)
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let out = hasher.finalize();
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&out);
    buf
}

/// 记录子密钥的 `info`：逐字拼接，不做任何格式化差异。
pub fn record_info(id: &str, purpose: &str, dek_ver: u32) -> String {
    format!("taskdock-vault/record/{id}/{purpose}/v{dek_ver}")
}

pub fn envelope_aad(vault_id: &str, slot: &str) -> String {
    format!("tdenv|{vault_id}|{slot}|v1")
}

pub fn record_aad(id: &str, purpose: &str, dek_ver: u32, data_ver: u32) -> String {
    format!("tdrec|{id}|{purpose}|v{dek_ver}|d{data_ver}")
}
