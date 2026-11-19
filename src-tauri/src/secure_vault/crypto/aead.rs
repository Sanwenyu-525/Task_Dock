//! AES-256-GCM 封装。每次调用生成新的 96-bit 随机 nonce；
//! 每条载荷使用独立子密钥，因此不存在单密钥多消息的 nonce 复用面。

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use zeroize::Zeroizing;

use crate::secure_vault::crypto::random_array;
use crate::secure_vault::error::VaultError;

pub struct Sealed {
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

pub fn seal(key: &[u8; 32], plaintext: &[u8], aad: &str) -> Result<Sealed, VaultError> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| VaultError::internal("aes:key_length"))?;
    let nonce: [u8; 12] = random_array()?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| VaultError::internal("aes:encrypt"))?;
    Ok(Sealed {
        nonce,
        ciphertext: ct,
    })
}

pub fn open(
    key: &[u8; 32],
    nonce: &[u8; 12],
    ciphertext: &[u8],
    aad: &str,
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| VaultError::internal("aes:key_length"))?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| VaultError::corrupt())?;
    Ok(Zeroizing::new(plaintext))
}

/// 只验证认证标签，不返回明文（导入前全量自检用）。
pub fn verify(
    key: &[u8; 32],
    nonce: &[u8; 12],
    ciphertext: &[u8],
    aad: &str,
) -> Result<(), VaultError> {
    open(key, nonce, ciphertext, aad).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] {
        [3u8; 32]
    }

    #[test]
    fn same_plaintext_produces_different_ciphertext() {
        let a = seal(&key(), b"secret", "aad").unwrap();
        let b = seal(&key(), b"secret", "aad").unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn tamper_and_cross_aad_are_rejected() {
        let sealed = seal(&key(), b"secret", "aad-1").unwrap();
        let mut tampered = sealed.ciphertext.clone();
        tampered[0] ^= 1;
        assert!(open(&key(), &sealed.nonce, &tampered, "aad-1").is_err());
        assert!(open(&key(), &sealed.nonce, &sealed.ciphertext, "aad-2").is_err());
        assert!(open(&key(), &sealed.nonce, &sealed.ciphertext, "aad-1").is_ok());
    }
}
