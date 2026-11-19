//! `DeviceManager` —— 已配对设备的本地登记、查询、撤销与签名校验（P3）。
//!
//! 安全语义（基线 §6.3 / §12）：
//! - 撤销立即生效：`revoked_at` 非空的设备在 `verify_device_signature` 中**先于**
//!   任何密码学校验被拒绝，且写审计；
//! - 配对只授予 `DEVICE_PAIRED` / `HUB_DISCOVERY`，本模块**不存在**
//!   `REMOTE_CONTROL` 常量或授予路径；
//! - 设备公钥不可在未撤销的情况下被静默替换（身份密钥轮换不在 P3 范围）。

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::personal_hub::crypto;
use crate::personal_hub::error::{HubError, HubResult};
use crate::personal_hub::store::{HubStore, StoredDevice};

/// 配对成功后的固定能力集（契约 §3.2 / §7）。
pub const CAP_DEVICE_PAIRED: &str = "DEVICE_PAIRED";
pub const CAP_HUB_DISCOVERY: &str = "HUB_DISCOVERY";
pub const PAIRED_CAPABILITIES: [&str; 2] = [CAP_DEVICE_PAIRED, CAP_HUB_DISCOVERY];

pub const DEVICE_TYPE_ANDROID: &str = "android";
pub const DEVICE_TYPE_WINDOWS_HUB: &str = "windows-hub";

/// 设备登记输入（配对批准后由 PC 本地写入）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegistration {
    pub device_id: String,
    pub device_type: String,
    pub display_name: String,
    /// base64(32 raw bytes)。
    pub identity_public_key: String,
    /// hex32。
    pub identity_fingerprint: String,
}

/// 已配对设备的公开展示信息（不含任何私钥/令牌）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub device_id: String,
    pub device_type: String,
    pub display_name: String,
    pub identity_public_key: String,
    pub identity_fingerprint: String,
    pub capabilities: Vec<String>,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
}

impl PairedDevice {
    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some()
    }

    fn from_stored(device: StoredDevice) -> Self {
        Self {
            device_id: device.device_id,
            device_type: device.device_type,
            display_name: device.display_name,
            identity_public_key: device.identity_public_key,
            identity_fingerprint: device.identity_fingerprint,
            capabilities: device.capabilities,
            paired_at: device.paired_at,
            last_seen_at: device.last_seen_at,
            revoked_at: device.revoked_at,
        }
    }
}

pub struct DeviceManager {
    store: Arc<HubStore>,
}

impl DeviceManager {
    pub fn new(store: Arc<HubStore>) -> Self {
        Self { store }
    }

    /// 登记/更新已配对设备。已撤销设备不会被重新激活。
    pub fn register_device(&self, registration: DeviceRegistration) -> HubResult<String> {
        validate_registration(&registration)?;
        let now = crypto::now_iso8601_millis();

        if let Some(existing) = self.store.get_device(&registration.device_id)? {
            if existing.is_revoked() {
                return Err(HubError::DeviceRevoked);
            }
            let existing_key = crypto::b64_decode(&existing.identity_public_key)?;
            let incoming_key = crypto::b64_decode(&registration.identity_public_key)?;
            if existing_key != incoming_key
                || !crypto::ct_eq_str(
                    &existing.identity_fingerprint,
                    &registration.identity_fingerprint,
                )
            {
                return Err(HubError::Identity(
                    "device identity key changed without revocation".into(),
                ));
            }
            self.store.upsert_device(&StoredDevice {
                device_id: existing.device_id,
                device_type: existing.device_type,
                display_name: registration.display_name,
                identity_public_key: existing.identity_public_key,
                identity_fingerprint: existing.identity_fingerprint,
                capabilities: fixed_capabilities(),
                paired_at: existing.paired_at,
                last_seen_at: Some(now),
                revoked_at: None,
                revoke_reason: None,
            })?;
            return Ok(registration.device_id);
        }

        self.store.upsert_device(&StoredDevice {
            device_id: registration.device_id.clone(),
            device_type: registration.device_type,
            display_name: registration.display_name,
            identity_public_key: registration.identity_public_key,
            identity_fingerprint: registration.identity_fingerprint,
            capabilities: fixed_capabilities(),
            paired_at: now.clone(),
            last_seen_at: Some(now),
            revoked_at: None,
            revoke_reason: None,
        })?;
        Ok(registration.device_id)
    }

    pub fn get_device_by_id(&self, device_id: &str) -> HubResult<Option<PairedDevice>> {
        Ok(self
            .store
            .get_device(device_id)?
            .map(PairedDevice::from_stored))
    }

    /// 列出未撤销的已配对设备。
    pub fn list_paired_devices(&self) -> HubResult<Vec<PairedDevice>> {
        Ok(self
            .store
            .list_devices(false)?
            .into_iter()
            .map(PairedDevice::from_stored)
            .collect())
    }

    /// 撤销设备：置 `revoked_at`、写审计；重复撤销幂等。
    pub fn revoke_device(&self, device_id: &str, reason: &str) -> HubResult<()> {
        UuidCheck::ensure(device_id)?;
        let reason = reason.trim();
        if reason.is_empty() || reason.chars().count() > 256 {
            return Err(HubError::Storage(
                "revoke reason must be 1..=256 characters".into(),
            ));
        }
        let device = self
            .store
            .get_device(device_id)?
            .ok_or_else(|| HubError::Identity("unknown device".into()))?;
        if device.is_revoked() {
            return Ok(());
        }
        let now = crypto::now_iso8601_millis();
        let changed = self.store.mark_device_revoked(device_id, &now, reason)?;
        if changed {
            self.store.append_audit(
                "DEVICE_REVOKED",
                Some(device_id),
                None,
                Some(&device.identity_fingerprint),
                "revoked",
                None,
                &now,
            )?;
        }
        Ok(())
    }

    /// 设备请求签名校验。撤销检查先于验签（撤销后所有请求立即被拒）。
    pub fn verify_device_signature(
        &self,
        device_id: &str,
        payload: &[u8],
        signature: &[u8],
    ) -> HubResult<()> {
        let device = self
            .store
            .get_device(device_id)?
            .ok_or_else(|| HubError::Identity("unknown device".into()))?;
        if device.is_revoked() {
            self.audit_denied(device_id, &device.identity_fingerprint, "DEVICE_REVOKED")?;
            return Err(HubError::DeviceRevoked);
        }
        let public_key = crypto::b64_decode(&device.identity_public_key)?;
        match crypto::verify_ed25519(&public_key, payload, signature) {
            Ok(()) => Ok(()),
            Err(_) => {
                self.audit_denied(
                    device_id,
                    &device.identity_fingerprint,
                    "INVALID_SIGNATURE",
                )?;
                Err(HubError::Identity("device signature verification failed".into()))
            }
        }
    }

    fn audit_denied(
        &self,
        device_id: &str,
        fingerprint: &str,
        code: &str,
    ) -> HubResult<()> {
        self.store.append_audit(
            "SECURITY_FAILURE",
            Some(device_id),
            None,
            Some(fingerprint),
            "DENY",
            Some(code),
            &crypto::now_iso8601_millis(),
        )
    }
}

fn fixed_capabilities() -> Vec<String> {
    PAIRED_CAPABILITIES
        .iter()
        .map(|value| (*value).to_string())
        .collect()
}

fn validate_registration(registration: &DeviceRegistration) -> HubResult<()> {
    UuidCheck::ensure(&registration.device_id)?;
    if registration.device_type != DEVICE_TYPE_ANDROID
        && registration.device_type != DEVICE_TYPE_WINDOWS_HUB
    {
        return Err(HubError::Identity(format!(
            "unsupported device type: {}",
            registration.device_type
        )));
    }
    let name_len = registration.display_name.trim().chars().count();
    if name_len == 0 || name_len > 128 {
        return Err(HubError::Identity(
            "device display name must be 1..=128 characters".into(),
        ));
    }
    let public_key = crypto::b64_decode(&registration.identity_public_key)?;
    if public_key.len() != 32 {
        return Err(HubError::Identity(format!(
            "identity public key must be 32 bytes, got {}",
            public_key.len()
        )));
    }
    let expected = crypto::fingerprint_of_public_key(&public_key)?;
    if !crypto::ct_eq_str(&expected, &registration.identity_fingerprint) {
        return Err(HubError::Identity(
            "device fingerprint does not match identity public key".into(),
        ));
    }
    Ok(())
}

struct UuidCheck;

impl UuidCheck {
    fn ensure(value: &str) -> HubResult<()> {
        uuid::Uuid::parse_str(value)
            .map(|_| ())
            .map_err(|_| HubError::Identity("device id must be a UUID".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::path::PathBuf;

    fn temp_store(tag: &str) -> (Arc<HubStore>, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-ph-devices-{}-{}-{}",
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

    fn registration_for(key: &SigningKey) -> DeviceRegistration {
        let public_key = key.verifying_key().to_bytes();
        DeviceRegistration {
            device_id: "44444444-4444-4444-8444-444444444444".into(),
            device_type: DEVICE_TYPE_ANDROID.into(),
            display_name: "Pixel Test".into(),
            identity_public_key: crypto::b64_encode(&public_key),
            identity_fingerprint: crypto::fingerprint_of_public_key(&public_key).unwrap(),
        }
    }

    #[test]
    fn register_grants_only_paired_and_discovery() {
        let (store, dir) = temp_store("caps");
        let manager = DeviceManager::new(store);
        let key = SigningKey::from_bytes(&[7u8; 32]);
        manager.register_device(registration_for(&key)).unwrap();

        let device = manager
            .get_device_by_id("44444444-4444-4444-8444-444444444444")
            .unwrap()
            .unwrap();
        assert_eq!(device.capabilities, vec!["DEVICE_PAIRED", "HUB_DISCOVERY"]);
        assert!(!device.capabilities.iter().any(|c| c == "REMOTE_CONTROL"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn signature_round_trip_and_tamper_rejected() {
        let (store, dir) = temp_store("signature");
        let manager = DeviceManager::new(store);
        let key = SigningKey::from_bytes(&[9u8; 32]);
        let registration = registration_for(&key);
        let device_id = registration.device_id.clone();
        manager.register_device(registration).unwrap();

        let payload = b"control-plane-request";
        let signature = key.sign(payload).to_bytes();
        manager
            .verify_device_signature(&device_id, payload, &signature)
            .expect("valid device signature");

        manager
            .verify_device_signature(&device_id, b"control-plane-requesT", &signature)
            .expect_err("tampered payload must fail");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn revoked_device_is_rejected_even_with_valid_signature() {
        let (store, dir) = temp_store("revoked");
        let manager = DeviceManager::new(store);
        let key = SigningKey::from_bytes(&[11u8; 32]);
        let registration = registration_for(&key);
        let device_id = registration.device_id.clone();
        manager.register_device(registration).unwrap();

        let payload = b"still-valid-signature";
        let signature = key.sign(payload).to_bytes();
        manager
            .verify_device_signature(&device_id, payload, &signature)
            .expect("valid before revocation");

        manager.revoke_device(&device_id, "user_requested").unwrap();
        let device = manager.get_device_by_id(&device_id).unwrap().unwrap();
        assert!(device.revoked_at.is_some());
        assert!(manager.list_paired_devices().unwrap().is_empty());

        match manager.verify_device_signature(&device_id, payload, &signature) {
            Err(HubError::DeviceRevoked) => {}
            other => panic!("expected DeviceRevoked, got {:?}", other),
        }

        // 重复撤销幂等；重新登记不能复活已撤销设备。
        manager.revoke_device(&device_id, "user_requested").unwrap();
        assert!(matches!(
            manager.register_device(registration_for(&key)),
            Err(HubError::DeviceRevoked)
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_fingerprint_mismatch_and_invalid_uuid() {
        let (store, dir) = temp_store("validation");
        let manager = DeviceManager::new(store);
        let key = SigningKey::from_bytes(&[13u8; 32]);
        let mut registration = registration_for(&key);
        registration.identity_fingerprint = "0".repeat(32);
        assert!(matches!(
            manager.register_device(registration),
            Err(HubError::Identity(_))
        ));

        let mut registration = registration_for(&key);
        registration.device_id = "not-a-uuid".into();
        assert!(manager.register_device(registration).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
