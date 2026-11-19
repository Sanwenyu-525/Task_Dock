//! Control Plane 请求/响应数据类型（契约 §3.2）。

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::personal_hub::crypto;
use crate::personal_hub::devices::{DeviceRegistration, DEVICE_TYPE_ANDROID, DEVICE_TYPE_WINDOWS_HUB};
use crate::personal_hub::error::{HubError, HubResult};

/// 云端 `POST /v1/invitations/create` 的成功结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedInvitation {
    pub invitation_id: String,
    pub issuer_device_id: String,
    pub nonce: String,
    pub created_at: String,
    pub expires_at: String,
    pub status: String,
    /// 一次性 128-bit secret 的 base64；只用于生成二维码，绝不持久化。
    pub invitation_secret: String,
}

/// 待 PC 批准的配对申请（契约 §3.2 (2)）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPairingRequest {
    pub request_id: String,
    pub device_id: String,
    pub device_type: String,
    pub display_name: String,
    pub identity_fingerprint: String,
    pub identity_public_key: String,
    pub requested_at: String,
    pub expires_at: String,
}

impl PendingPairingRequest {
    /// 云端返回值自洽性校验；任何不一致都拒绝（fail closed）。
    pub fn validate(&self) -> HubResult<()> {
        Uuid::parse_str(&self.request_id)
            .map_err(|_| HubError::Identity("pairing request id must be a UUID".into()))?;
        Uuid::parse_str(&self.device_id)
            .map_err(|_| HubError::Identity("pairing device id must be a UUID".into()))?;
        if self.device_type != DEVICE_TYPE_ANDROID && self.device_type != DEVICE_TYPE_WINDOWS_HUB {
            return Err(HubError::Identity(format!(
                "unsupported pairing device type: {}",
                self.device_type
            )));
        }
        if self.display_name.trim().is_empty() || self.display_name.chars().count() > 128 {
            return Err(HubError::Identity(
                "pairing display name must be 1..=128 characters".into(),
            ));
        }
        let public_key = crypto::b64_decode(&self.identity_public_key)?;
        if public_key.len() != 32 {
            return Err(HubError::Identity(
                "pairing identity public key must be 32 bytes".into(),
            ));
        }
        let expected = crypto::fingerprint_of_public_key(&public_key)?;
        if !crypto::ct_eq_str(&expected, &self.identity_fingerprint) {
            return Err(HubError::Identity(
                "pairing fingerprint does not match identity public key".into(),
            ));
        }
        if chrono::DateTime::parse_from_rfc3339(&self.requested_at).is_err()
            || chrono::DateTime::parse_from_rfc3339(&self.expires_at).is_err()
        {
            return Err(HubError::Identity(
                "pairing request timestamps must be UTC ISO-8601".into(),
            ));
        }
        Ok(())
    }

    pub fn is_expired(&self, now: &str) -> bool {
        crypto::is_expired(&self.expires_at, now)
    }

    pub fn to_registration(&self) -> DeviceRegistration {
        DeviceRegistration {
            device_id: self.device_id.clone(),
            device_type: self.device_type.clone(),
            display_name: self.display_name.clone(),
            identity_public_key: self.identity_public_key.clone(),
            identity_fingerprint: self.identity_fingerprint.clone(),
        }
    }
}

/// 云端批准/拒绝结果（契约 §3.2 (3)）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecideOutcome {
    pub status: String,
    /// 云端返回的设备（仅用于与 PC 已展示的申请做一致性比对）。
    pub device: Option<CloudDevice>,
    /// 云端声明授予的能力；本地**不采用**，只用于契约违规检测。
    pub paired_capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDevice {
    pub device_id: String,
    pub device_type: String,
    pub display_name: String,
    pub identity_public_key: String,
    pub identity_fingerprint: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn valid_request() -> PendingPairingRequest {
        let key = SigningKey::from_bytes(&[3u8; 32]);
        let public_key = key.verifying_key().to_bytes();
        PendingPairingRequest {
            request_id: "55555555-5555-4555-8555-555555555555".into(),
            device_id: "66666666-6666-4666-8666-666666666666".into(),
            device_type: "android".into(),
            display_name: "Pixel 8".into(),
            identity_fingerprint: crypto::fingerprint_of_public_key(&public_key).unwrap(),
            identity_public_key: crypto::b64_encode(&public_key),
            requested_at: "2026-11-19T04:00:00.000Z".into(),
            expires_at: "2026-11-19T04:05:00.000Z".into(),
        }
    }

    #[test]
    fn valid_request_passes_consistency_check() {
        valid_request().validate().expect("valid request");
    }

    #[test]
    fn fingerprint_mismatch_is_rejected() {
        let mut request = valid_request();
        request.identity_fingerprint = "0".repeat(32);
        assert!(request.validate().is_err());
    }

    #[test]
    fn invalid_uuid_is_rejected() {
        let mut request = valid_request();
        request.request_id = "nope".into();
        assert!(request.validate().is_err());
    }
}
