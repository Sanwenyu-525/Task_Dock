//! Control Plane HTTPS 客户端（P3 最小实现，契约 §1 / §3）。
//!
//! 安全约束：
//! - 只接受 `https://` 基地址；**不降级到 HTTP**；
//! - 使用 reqwest + native-tls（Windows schannel），系统证书链校验保持默认开启；
//!   代码中不存在任何关闭证书/主机名校验的调用；
//! - 禁止跟随重定向（防止 TLS → 明文/其他主机降级）；
//! - 每个请求体按契约 §1 以 Ed25519 签名（canonical JSON，剔除 signature）。
//!
//! 云端未启动时由 `ControlPlane` trait 的测试替身覆盖；真实联调单独标注。

use std::sync::Arc;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::personal_hub::cloud::types::{
    CloudDevice, CreatedInvitation, DecideOutcome, PendingPairingRequest,
};
use crate::personal_hub::crypto;
use crate::personal_hub::error::{HubError, HubResult};
use crate::personal_hub::identity::IdentityManager;

/// 云端配对/邀请接口抽象：生产实现走 HTTPS，单元测试使用本地替身。
pub trait ControlPlane: Send + Sync {
    fn base_url(&self) -> &str;

    fn create_invitation(
        &self,
        issuer_device_id: &str,
        ttl_seconds: u32,
    ) -> HubResult<CreatedInvitation>;

    fn list_pairing_requests(
        &self,
        issuer_device_id: &str,
    ) -> HubResult<Vec<PendingPairingRequest>>;

    fn decide_pairing_request(
        &self,
        request_id: &str,
        issuer_device_id: &str,
        approved: bool,
    ) -> HubResult<DecideOutcome>;
}

pub struct HttpControlPlane {
    base_url: String,
    client: Client,
    identity: Arc<IdentityManager>,
}

impl HttpControlPlane {
    /// `base_url` 必须是 https；否则拒绝构造（fail closed）。
    pub fn new(base_url: &str, identity: Arc<IdentityManager>) -> HubResult<Self> {
        let base_url = base_url.trim().trim_end_matches('/').to_string();
        if base_url.is_empty() {
            return Err(HubError::Network("control plane URL is empty".into()));
        }
        let lower = base_url.to_ascii_lowercase();
        if !lower.starts_with("https://") {
            return Err(HubError::Network(
                "control plane must use https:// (TLS is mandatory)".into(),
            ));
        }
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            // 不跟随重定向：避免被引导到明文或未固定主机。
            .redirect(Policy::none())
            .build()
            .map_err(|e| HubError::Network(format!("build HTTPS client failed: {}", e)))?;
        Ok(Self {
            base_url,
            client,
            identity,
        })
    }

    /// 构造契约 §1 的签名请求体（timestamp/nonce/signature）。
    fn sign_body(&self, mut fields: Map<String, Value>) -> HubResult<Value> {
        fields.insert(
            "timestamp".into(),
            Value::String(crypto::now_iso8601_millis()),
        );
        fields.insert(
            "nonce".into(),
            Value::String(Uuid::new_v4().to_string()),
        );
        let signable = crypto::signable_payload(&fields)?;
        let signature = self.identity.sign_payload(signable.as_bytes())?;
        fields.insert("signature".into(), Value::String(signature.to_base64()));
        Ok(Value::Object(fields))
    }

    fn post_signed(&self, path: &str, fields: Map<String, Value>) -> HubResult<Value> {
        let body = self.sign_body(fields)?;
        let url = format!("{}{}", self.base_url, path);
        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .map_err(|e| HubError::Network(format!("control plane request failed: {}", e)))?;
        let status = response.status();
        let text = response
            .text()
            .map_err(|e| HubError::Network(format!("read control plane response failed: {}", e)))?;
        let value: Value = serde_json::from_str(&text).map_err(|_| {
            HubError::Network(format!(
                "control plane returned non-JSON response (HTTP {}): {}",
                status.as_u16(),
                truncate(&text)
            ))
        })?;
        if !status.is_success() {
            return Err(cloud_error(status, &value));
        }
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(cloud_error(status, &value));
        }
        Ok(value)
    }
}

impl ControlPlane for HttpControlPlane {
    fn base_url(&self) -> &str {
        &self.base_url
    }

    fn create_invitation(
        &self,
        issuer_device_id: &str,
        ttl_seconds: u32,
    ) -> HubResult<CreatedInvitation> {
        let mut fields = Map::new();
        fields.insert(
            "issuerDeviceId".into(),
            Value::String(issuer_device_id.to_string()),
        );
        fields.insert("ttlSeconds".into(), json!(ttl_seconds));
        let value = self.post_signed("/v1/invitations/create", fields)?;

        #[derive(Deserialize)]
        struct Envelope {
            invitation: Invitation,
            #[serde(rename = "invitationSecret")]
            invitation_secret: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Invitation {
            invitation_id: String,
            issuer_device_id: String,
            nonce: String,
            created_at: String,
            expires_at: String,
            status: String,
        }

        let envelope: Envelope = serde_json::from_value(value)
            .map_err(|e| HubError::Network(format!("invalid invitation response: {}", e)))?;
        let secret = crypto::b64_decode(&envelope.invitation_secret)?;
        if secret.len() != 16 {
            return Err(HubError::Network(
                "invitation secret must be 16 raw bytes".into(),
            ));
        }
        if envelope.invitation.issuer_device_id != issuer_device_id {
            return Err(HubError::Identity(
                "cloud returned invitation for another issuer".into(),
            ));
        }
        if envelope.invitation.status != "pending" {
            return Err(HubError::InvalidInvitation(format!(
                "cloud returned invitation status {}",
                envelope.invitation.status
            )));
        }
        if Uuid::parse_str(&envelope.invitation.invitation_id).is_err()
            || Uuid::parse_str(&envelope.invitation.nonce).is_err()
            || chrono::DateTime::parse_from_rfc3339(&envelope.invitation.created_at).is_err()
            || chrono::DateTime::parse_from_rfc3339(&envelope.invitation.expires_at).is_err()
        {
            return Err(HubError::Network(
                "cloud invitation fields are not valid UUID/ISO-8601".into(),
            ));
        }

        Ok(CreatedInvitation {
            invitation_id: envelope.invitation.invitation_id,
            issuer_device_id: envelope.invitation.issuer_device_id,
            nonce: envelope.invitation.nonce,
            created_at: envelope.invitation.created_at,
            expires_at: envelope.invitation.expires_at,
            status: envelope.invitation.status,
            invitation_secret: envelope.invitation_secret,
        })
    }

    fn list_pairing_requests(
        &self,
        issuer_device_id: &str,
    ) -> HubResult<Vec<PendingPairingRequest>> {
        let mut fields = Map::new();
        fields.insert(
            "issuerDeviceId".into(),
            Value::String(issuer_device_id.to_string()),
        );
        let value = self.post_signed("/v1/pairing/requests/list", fields)?;

        #[derive(Deserialize)]
        struct Envelope {
            requests: Vec<PendingPairingRequest>,
        }
        let envelope: Envelope = serde_json::from_value(value)
            .map_err(|e| HubError::Network(format!("invalid pairing list response: {}", e)))?;
        for request in &envelope.requests {
            request.validate()?;
        }
        Ok(envelope.requests)
    }

    fn decide_pairing_request(
        &self,
        request_id: &str,
        issuer_device_id: &str,
        approved: bool,
    ) -> HubResult<DecideOutcome> {
        let mut fields = Map::new();
        fields.insert("requestId".into(), Value::String(request_id.to_string()));
        fields.insert(
            "issuerDeviceId".into(),
            Value::String(issuer_device_id.to_string()),
        );
        fields.insert("approved".into(), Value::Bool(approved));
        let value = self.post_signed("/v1/pairing/decide", fields)?;

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Envelope {
            status: String,
            device: Option<CloudDevice>,
            paired_capabilities: Option<Vec<String>>,
        }
        let envelope: Envelope = serde_json::from_value(value)
            .map_err(|e| HubError::Network(format!("invalid pairing decide response: {}", e)))?;
        Ok(DecideOutcome {
            status: envelope.status,
            device: envelope.device,
            paired_capabilities: envelope.paired_capabilities.unwrap_or_default(),
        })
    }
}

fn truncate(text: &str) -> String {
    text.chars().take(200).collect()
}

fn cloud_error(status: StatusCode, value: &Value) -> HubError {
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN");
    match code {
        "INVALID_INVITATION" | "INVITATION_EXPIRED" | "INVITATION_NOT_PENDING" => {
            HubError::InvalidInvitation(code.to_string())
        }
        "DEVICE_REVOKED" => HubError::DeviceRevoked,
        "IDENTITY_MISMATCH"
        | "INVALID_SIGNATURE"
        | "FINGERPRINT_MISMATCH"
        | "STALE_TIMESTAMP"
        | "REPLAY_DETECTED"
        | "DEVICE_NOT_FOUND" => HubError::Identity(format!("control plane rejected: {}", code)),
        "RATE_LIMITED" => HubError::PermissionDenied("control plane rate limited".into()),
        other => HubError::Network(format!(
            "control plane error {} (HTTP {})",
            other,
            status.as_u16()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personal_hub::store::HubStore;
    use std::path::PathBuf;

    fn temp_identity(tag: &str) -> (Arc<IdentityManager>, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-ph-cloud-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = HubStore::open(dir.join("hub.db")).expect("open temp hub.db");
        let identity = Arc::new(IdentityManager::new(store));
        identity.load_identity().expect("identity");
        (identity, dir)
    }

    #[test]
    fn rejects_plaintext_http_base_url() {
        let (identity, dir) = temp_identity("http");
        assert!(HttpControlPlane::new("http://127.0.0.1:8080", identity.clone()).is_err());
        assert!(HttpControlPlane::new("hub.example.com", identity.clone()).is_err());
        assert!(HttpControlPlane::new("https://hub.example.com/", identity).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 安全护栏：源码中不得出现关闭 TLS 校验的调用。
    #[test]
    fn tls_verification_is_never_disabled_in_source() {
        let source = include_str!("client.rs");
        // 分片拼接，避免本测试自身把被禁字符串写进源码。
        let invalid_certs = ["danger", "accept", "invalid", "certs"].join("_");
        let invalid_hosts = ["danger", "accept", "invalid", "hostnames"].join("_");
        let dangerous = ["danger", "ous()"].concat();
        assert!(!source.contains(&invalid_certs));
        assert!(!source.contains(&invalid_hosts));
        assert!(!source.contains(&dangerous));
    }

    #[test]
    fn signed_body_is_verifiable_by_issuer_public_key() {
        let (identity, dir) = temp_identity("sign-body");
        let client =
            HttpControlPlane::new("https://hub.example.com", identity.clone()).unwrap();
        let mut fields = Map::new();
        fields.insert(
            "issuerDeviceId".into(),
            Value::String(identity.get_device_id().unwrap()),
        );
        let body = client.sign_body(fields).unwrap();
        let map = body.as_object().unwrap().clone();
        assert!(map.contains_key("timestamp"));
        assert!(map.contains_key("nonce"));
        let signature = crypto::b64_decode(map.get("signature").unwrap().as_str().unwrap()).unwrap();
        let signable = crypto::signable_payload(&map).unwrap();
        let public_key = identity
            .load_identity()
            .unwrap()
            .public_key_bytes()
            .unwrap();
        crypto::verify_ed25519(&public_key, signable.as_bytes(), &signature)
            .expect("signed body must verify");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cloud_error_maps_security_codes() {
        let value = json!({"code": "DEVICE_REVOKED"});
        assert!(matches!(
            cloud_error(StatusCode::FORBIDDEN, &value),
            HubError::DeviceRevoked
        ));
        let value = json!({"code": "INVALID_INVITATION"});
        assert!(matches!(
            cloud_error(StatusCode::BAD_REQUEST, &value),
            HubError::InvalidInvitation(_)
        ));
        let value = json!({"code": "RATE_LIMITED"});
        assert!(matches!(
            cloud_error(StatusCode::TOO_MANY_REQUESTS, &value),
            HubError::PermissionDenied(_)
        ));
    }
}
