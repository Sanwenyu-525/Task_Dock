//! 密钥信封：把 DEK 用 KEK 封装成 JSON，连同 KDF 参数一起落库。
//!
//! 信封内**没有**主密码、没有 KEK、没有明文 DEK。

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::secure_vault::crypto::aead;
use crate::secure_vault::crypto::envelope_aad;
use crate::secure_vault::crypto::secret_bytes::{b64_decode, b64_encode};
use crate::secure_vault::crypto::{ENVELOPE_FORMAT, ENVELOPE_VERSION};
use crate::secure_vault::error::VaultError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfInfo {
    pub alg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lib_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub m_cost_kib: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t_cost: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p_cost: Option<u32>,
    pub salt_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wrap {
    pub alg: String,
    pub nonce_b64: String,
    pub ct_b64: String,
    pub aad: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub format: String,
    pub version: u32,
    pub vault_id: String,
    pub slot: String,
    pub kdf: KdfInfo,
    pub wrap: Wrap,
    pub dek_ver: u32,
    pub created_at: String,
    pub updated_at: String,
}

impl Envelope {
    pub fn to_json(&self) -> Result<String, VaultError> {
        Ok(serde_json::to_string(self)?)
    }

    pub fn from_json(raw: &str) -> Result<Self, VaultError> {
        let env: Envelope = serde_json::from_str(raw)?;
        if env.format != ENVELOPE_FORMAT {
            return Err(VaultError::corrupt());
        }
        if env.version != ENVELOPE_VERSION {
            return Err(VaultError::format_unsupported(env.version, ENVELOPE_VERSION));
        }
        Ok(env)
    }

    pub fn argon2_params(&self) -> Result<crate::secure_vault::crypto::kdf::Argon2Params, VaultError> {
        let m = self
            .kdf
            .m_cost_kib
            .ok_or_else(|| VaultError::corrupt())?;
        let t = self.kdf.t_cost.ok_or_else(|| VaultError::corrupt())?;
        let p = self.kdf.p_cost.ok_or_else(|| VaultError::corrupt())?;
        Ok(crate::secure_vault::crypto::kdf::Argon2Params {
            m_cost_kib: m,
            t_cost: t,
            p_cost: p,
        })
    }

    pub fn salt(&self) -> Result<[u8; 16], VaultError> {
        let bytes = b64_decode(&self.kdf.salt_b64)?;
        if bytes.len() != 16 {
            return Err(VaultError::corrupt());
        }
        let mut out = [0u8; 16];
        out.copy_from_slice(&bytes);
        Ok(out)
    }
}

pub fn wrap_dek(
    kek: &[u8; 32],
    dek: &[u8; 32],
    vault_id: &str,
    slot: &str,
) -> Result<Wrap, VaultError> {
    let aad = envelope_aad(vault_id, slot);
    let sealed = aead::seal(kek, dek, &aad)?;
    Ok(Wrap {
        alg: "aes-256-gcm".to_string(),
        nonce_b64: b64_encode(&sealed.nonce),
        ct_b64: b64_encode(&sealed.ciphertext),
        aad,
    })
}

pub fn unwrap_dek(
    kek: &[u8; 32],
    wrap: &Wrap,
    vault_id: &str,
    slot: &str,
) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let aad = envelope_aad(vault_id, slot);
    if wrap.aad != aad {
        return Err(VaultError::corrupt());
    }
    let nonce: [u8; 12] = {
        let b = b64_decode(&wrap.nonce_b64)?;
        if b.len() != 12 {
            return Err(VaultError::corrupt());
        }
        let mut n = [0u8; 12];
        n.copy_from_slice(&b);
        n
    };
    let ct = b64_decode(&wrap.ct_b64)?;
    let plaintext = aead::open(kek, &nonce, &ct, &aad)?;
    if plaintext.len() != 32 {
        return Err(VaultError::corrupt());
    }
    let mut dek = Zeroizing::new([0u8; 32]);
    dek.copy_from_slice(&plaintext);
    Ok(dek)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_and_unwrap_roundtrip() {
        let kek = [5u8; 32];
        let dek = [6u8; 32];
        let w = wrap_dek(&kek, &dek, "vault-1", "master").unwrap();
        let out = unwrap_dek(&kek, &w, "vault-1", "master").unwrap();
        assert_eq!(out[..], dek[..]);
    }

    #[test]
    fn wrong_slot_or_kek_fails() {
        let kek = [5u8; 32];
        let dek = [6u8; 32];
        let w = wrap_dek(&kek, &dek, "vault-1", "master").unwrap();
        assert!(unwrap_dek(&kek, &w, "vault-1", "recovery").is_err());
        assert!(unwrap_dek(&[7u8; 32], &w, "vault-1", "master").is_err());
        assert!(unwrap_dek(&kek, &w, "vault-2", "master").is_err());
    }
}
