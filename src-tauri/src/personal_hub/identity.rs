//! `IdentityManager` —— 设备身份（Ed25519）与本地密钥保护（P3，基线 §6.1）。
//!
//! - 首次运行本机生成 Ed25519 密钥对与 UUID v4 `device_id`，之后只加载不覆盖；
//! - 私钥只以 Windows DPAPI（当前用户作用域）密文存 SQLite，明文不落盘；
//! - 签名/验签使用 RFC 8032 实现（`ed25519-dalek`），不自研密码算法；
//! - 指纹：`hex(sha256(raw32 pubkey))[0..32]`（契约 §1）。
//!
//! 禁止：私钥进入日志、Named Pipe 响应、备份或云端；本模块不提供任何
//! 「导出私钥」接口。

use std::sync::Arc;

use ed25519_dalek::{Signer, SigningKey};
use serde::Serialize;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::personal_hub::crypto::{self, dpapi};
use crate::personal_hub::error::{HubError, HubResult};
use crate::personal_hub::store::{HubStore, StoredDeviceKey};

/// 签名结果的公开表示（64 字节；base64 编码见 `to_base64`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signature {
    bytes: [u8; 64],
}

impl Signature {
    pub fn as_bytes(&self) -> &[u8; 64] {
        &self.bytes
    }

    pub fn to_base64(&self) -> String {
        crypto::b64_encode(&self.bytes)
    }
}

/// 设备身份的公开展示部分（绝不含私钥）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    /// base64(32 raw bytes)，非 DER（契约 §1）。
    pub public_key: String,
    /// 小写 hex，前 32 字符。
    pub fingerprint: String,
}

impl DeviceIdentity {
    pub fn public_key_bytes(&self) -> HubResult<Vec<u8>> {
        let bytes = crypto::b64_decode(&self.public_key)?;
        if bytes.len() != 32 {
            return Err(HubError::Identity(format!(
                "stored public key length {}, expected 32",
                bytes.len()
            )));
        }
        Ok(bytes)
    }
}

pub struct IdentityManager {
    store: Arc<HubStore>,
}

impl IdentityManager {
    pub fn new(store: Arc<HubStore>) -> Self {
        Self { store }
    }

    /// 首次运行生成本机身份；已有身份时直接返回，绝不覆盖。
    pub fn initialize_identity(&self) -> HubResult<DeviceIdentity> {
        if let Some(stored) = self.store.load_device_key()? {
            return identity_from_stored(&stored);
        }

        let signing_key = SigningKey::generate(&mut rand::rngs::OsRng);
        let seed = Zeroizing::new(signing_key.to_bytes().to_vec());
        let verifying_key = signing_key.verifying_key();
        let public_key = verifying_key.to_bytes();
        let fingerprint = crypto::fingerprint_of_public_key(&public_key)?;
        let device_id = Uuid::new_v4().to_string();
        let protected = dpapi::protect(&seed[..])?;
        let created_at = crypto::now_iso8601_millis();

        let inserted = self.store.insert_device_key(
            &device_id,
            &crypto::b64_encode(&public_key),
            &protected,
            &created_at,
        )?;
        if !inserted {
            // 并发首次启动：另一实例已写入，加载它而不是覆盖。
            return self.load_identity();
        }

        Ok(DeviceIdentity {
            device_id,
            public_key: crypto::b64_encode(&public_key),
            fingerprint,
        })
    }

    /// 加载已存在身份；不存在则初始化（幂等）。
    pub fn load_identity(&self) -> HubResult<DeviceIdentity> {
        match self.store.load_device_key()? {
            Some(stored) => identity_from_stored(&stored),
            None => self.initialize_identity(),
        }
    }

    /// 对 UTF-8/二进制载荷签名（Ed25519，RFC 8032）。
    pub fn sign_payload(&self, payload: &[u8]) -> HubResult<Signature> {
        let (signing_key, _stored) = self.load_signing_key()?;
        let signature = signing_key.sign(payload);
        Ok(Signature {
            bytes: signature.to_bytes(),
        })
    }

    /// 校验对端签名；任何长度/格式/验签失败都返回 `Identity`（fail closed）。
    pub fn verify_peer_signature(
        &self,
        public_key: &[u8],
        payload: &[u8],
        signature: &[u8],
    ) -> HubResult<()> {
        crypto::verify_ed25519(public_key, payload, signature)
    }

    pub fn get_fingerprint(&self) -> HubResult<String> {
        Ok(self.load_identity()?.fingerprint)
    }

    pub fn get_device_id(&self) -> HubResult<String> {
        Ok(self.load_identity()?.device_id)
    }

    /// 仅供同 crate 测试：用固定 seed 建立可复现身份（验证契约 §5 向量）。
    #[cfg(test)]
    pub(crate) fn initialize_identity_from_seed(
        &self,
        seed: [u8; 32],
        device_id: &str,
    ) -> HubResult<DeviceIdentity> {
        let signing_key = SigningKey::from_bytes(&seed);
        let public_key = signing_key.verifying_key().to_bytes();
        let fingerprint = crypto::fingerprint_of_public_key(&public_key)?;
        let protected = dpapi::protect(&seed)?;
        let inserted = self.store.insert_device_key(
            device_id,
            &crypto::b64_encode(&public_key),
            &protected,
            &crypto::now_iso8601_millis(),
        )?;
        if !inserted {
            return Err(HubError::Storage(
                "test identity already initialized".into(),
            ));
        }
        Ok(DeviceIdentity {
            device_id: device_id.to_string(),
            public_key: crypto::b64_encode(&public_key),
            fingerprint,
        })
    }

    fn load_signing_key(&self) -> HubResult<(SigningKey, StoredDeviceKey)> {
        let stored = self
            .store
            .load_device_key()?
            .ok_or_else(|| HubError::Identity("device identity is not initialized".into()))?;
        if stored.key_alg != "Ed25519" {
            return Err(HubError::Identity(format!(
                "unsupported identity key algorithm: {}",
                stored.key_alg
            )));
        }
        let seed = Zeroizing::new(dpapi::unprotect(&stored.protected_private_key)?);
        if seed.len() != 32 {
            return Err(HubError::Identity(format!(
                "unprotected seed length {}, expected 32",
                seed.len()
            )));
        }
        let seed_bytes: [u8; 32] = seed
            .as_slice()
            .try_into()
            .map_err(|_| HubError::Identity("seed conversion failed".into()))?;
        Ok((SigningKey::from_bytes(&seed_bytes), stored))
    }
}

fn identity_from_stored(stored: &StoredDeviceKey) -> HubResult<DeviceIdentity> {
    let public_key = crypto::b64_decode(&stored.public_key_b64)?;
    if public_key.len() != 32 {
        return Err(HubError::Identity(format!(
            "stored public key length {}, expected 32",
            public_key.len()
        )));
    }
    let fingerprint = crypto::fingerprint_of_public_key(&public_key)?;
    Ok(DeviceIdentity {
        device_id: stored.device_id.clone(),
        public_key: stored.public_key_b64.clone(),
        fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personal_hub::crypto::canonical_json;
    use serde_json::json;
    use std::path::PathBuf;

    fn temp_store(tag: &str) -> (Arc<HubStore>, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-ph-identity-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = HubStore::open(dir.join("hub.db")).expect("open temp hub.db");
        (store, dir)
    }

    #[test]
    fn identity_generation_is_idempotent_across_reopen() {
        let (store, dir) = temp_store("idempotent");
        let first = IdentityManager::new(store.clone())
            .load_identity()
            .expect("initialize identity");
        drop(store);

        // 重新打开同一 DB（模拟进程重启）后必须得到同一 device_id 与公钥。
        let reopened = HubStore::open(dir.join("hub.db")).expect("reopen hub.db");
        let second = IdentityManager::new(reopened)
            .load_identity()
            .expect("load identity");
        assert_eq!(first, second);
        assert_eq!(first.device_id, second.device_id);
        assert_eq!(first.public_key, second.public_key);
        assert_eq!(first.fingerprint, second.fingerprint);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fingerprint_matches_contract_algorithm() {
        let (store, dir) = temp_store("fingerprint");
        let manager = IdentityManager::new(store);
        let identity = manager
            .initialize_identity_from_seed([1u8; 32], "11111111-1111-4111-8111-111111111111")
            .expect("seed identity");
        // node:crypto 对同一 raw 公钥计算的 sha256 前 32 字符。
        assert_eq!(identity.fingerprint, "34750f98bd59fcfc946da45aaabe933b");
        assert_eq!(
            identity.public_key,
            "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w="
        );
        assert_eq!(manager.get_fingerprint().unwrap(), identity.fingerprint);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 契约 §5：固定 seed（全 0x01）+ 固定 canonical 载荷，签名与 node:crypto 一致。
    #[test]
    fn ed25519_signature_matches_node_crypto_vector() {
        let (store, dir) = temp_store("vector");
        let manager = IdentityManager::new(store);
        manager
            .initialize_identity_from_seed([1u8; 32], "22222222-2222-4222-8222-222222222222")
            .expect("seed identity");

        let payload = canonical_json(&json!({
            "b": 1,
            "a": "x",
            "nested": { "z": true, "y": [3, 2, 1] }
        }))
        .unwrap();
        let signature = manager.sign_payload(payload.as_bytes()).unwrap();
        assert_eq!(
            signature.to_base64(),
            "JTOdQIzR9w/+B6biFIIV88YoUDhU29x7vwd6n9xhIYjnb2q0yvuB2nToiQRdg/Lnoghk/YwgfZfij9Lf+a4SBw=="
        );

        let identity = manager.load_identity().unwrap();
        let public_key = identity.public_key_bytes().unwrap();
        manager
            .verify_peer_signature(&public_key, payload.as_bytes(), signature.as_bytes())
            .expect("round trip verification");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tampered_payload_fails_verification() {
        let (store, dir) = temp_store("tamper");
        let manager = IdentityManager::new(store);
        let identity = manager.load_identity().unwrap();
        let payload = b"pairing-payload";
        let signature = manager.sign_payload(payload).unwrap();
        let public_key = identity.public_key_bytes().unwrap();

        manager
            .verify_peer_signature(&public_key, b"pairing-payloaX", signature.as_bytes())
            .expect_err("tampered payload must fail");
        manager
            .verify_peer_signature(&public_key, payload, &signature.as_bytes()[..63])
            .expect_err("truncated signature must fail");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 安全证据：DPAPI 密文落盘，数据库文件（含 WAL）中不出现明文 seed 字节。
    #[test]
    fn private_seed_is_not_present_in_plaintext_on_disk() {
        let (store, dir) = temp_store("dpapi-disk");
        let seed = [0x5au8; 32];
        let manager = IdentityManager::new(store);
        manager
            .initialize_identity_from_seed(seed, "33333333-3333-4333-8333-333333333333")
            .expect("seed identity");

        // 同时检查 hub.db 与 WAL/SHM 文件（WAL 模式下新写入可能尚未 checkpoint）。
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).expect("read temp dir") {
            let path = entry.expect("dir entry").path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if !name.starts_with("hub.db") {
                continue;
            }
            let bytes = std::fs::read(&path).expect("read db file");
            assert!(
                !bytes.windows(seed.len()).any(|window| window == seed),
                "plaintext seed found in {}",
                path.display()
            );
            checked += 1;
        }
        assert!(checked >= 1, "no hub.db file was checked");
        let _ = std::fs::remove_dir_all(dir);
    }
}
