//! `PairingManager` —— 二维码邀请、PC 本机批准、配对落库（P3，基线 §6.2 / 契约 §2–§4）。
//!
//! 流程（契约 §3.1）：
//! 1. Hub 调云端创建一次性邀请（5 分钟、一次性、最多 5 次错误尝试由云端执行）；
//! 2. Hub 本地组装并签名二维码载荷（不含私钥/长期令牌/远控授权）；
//! 3. Android 提交申请后状态为 `awaiting_pc_approval`；
//! 4. **PC 本机** `list_pending_requests` → `decide_pairing_request` 批准/拒绝；
//! 5. 只有 `approved` 才写入本地 `ph_devices`，能力固定为
//!    `DEVICE_PAIRED` / `HUB_DISCOVERY`，**永远不含 `REMOTE_CONTROL`**。
//!
//! 防中间人：二维码里的 `hpk` 只做自洽性校验；真实信任来自 PC 与手机双端
//! 指纹人工比对（基线 §6.2 第 7 步，UI 接入由主 Agent 完成）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::personal_hub::cloud::{ControlPlane, CreatedInvitation, PendingPairingRequest};
use crate::personal_hub::crypto;
use crate::personal_hub::devices::{DeviceManager, PairedDevice, PAIRED_CAPABILITIES};
use crate::personal_hub::error::{HubError, HubResult};
use crate::personal_hub::identity::IdentityManager;
use crate::personal_hub::store::{
    HubStore, StoredInvitation, INVITATION_EXPIRED, INVITATION_PENDING, INVITATION_REVOKED,
};

const PROTOCOL_VERSION: u32 = 1;
const MIN_TTL_SECONDS: u64 = 30;
const MAX_TTL_SECONDS: u64 = 300;
const REMOTE_CONTROL: &str = "REMOTE_CONTROL";

/// 一次性配对邀请（`invitation_secret` 只在内存中，绝不落盘/进日志）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInvitation {
    pub invitation_id: String,
    pub issuer_device_id: String,
    #[serde(skip_serializing)]
    pub invitation_secret: String,
    pub nonce: String,
    pub created_at: String,
    pub expires_at: String,
    pub status: String,
    pub control_plane: String,
    pub signature: String,
    pub qr_payload: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationClaims {
    pub invitation_id: String,
    pub issuer_device_id: String,
    pub nonce: String,
    pub expires_at: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingDecision {
    pub status: String,
    pub device: Option<PairedDevice>,
    pub capabilities: Vec<String>,
}

/// 二维码解码结构（契约 §2）；未知字段直接拒绝。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct QrEnvelope {
    v: u32,
    cp: String,
    iid: String,
    sec: String,
    nonce: String,
    exp: String,
    hid: String,
    hpk: String,
    hfp: String,
    sig: String,
}

pub struct PairingManager {
    store: Arc<HubStore>,
    identity: Arc<IdentityManager>,
    devices: Arc<DeviceManager>,
    cloud: Option<Arc<dyn ControlPlane>>,
    cloud_error: Option<String>,
    /// PC 已展示给用户的待批准申请（requestId → 申请），批准时比对防止云端中途换包。
    pending_cache: Mutex<HashMap<String, PendingPairingRequest>>,
}

impl PairingManager {
    pub fn new(
        store: Arc<HubStore>,
        identity: Arc<IdentityManager>,
        devices: Arc<DeviceManager>,
        cloud: Option<Arc<dyn ControlPlane>>,
        cloud_error: Option<String>,
    ) -> Self {
        Self {
            store,
            identity,
            devices,
            cloud,
            cloud_error,
            pending_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn control_plane_url(&self) -> Option<String> {
        self.cloud.as_ref().map(|cloud| cloud.base_url().to_string())
    }

    /// 创建邀请：云端发一次性 secret，本地签名二维码载荷。
    pub fn create_pairing_invitation(&self, ttl: Duration) -> HubResult<PairingInvitation> {
        let ttl_seconds = ttl.as_secs();
        if !(MIN_TTL_SECONDS..=MAX_TTL_SECONDS).contains(&ttl_seconds) {
            return Err(HubError::InvalidInvitation(format!(
                "invitation ttl must be {}..={} seconds",
                MIN_TTL_SECONDS, MAX_TTL_SECONDS
            )));
        }
        let cloud = self.require_cloud()?;
        let device_id = self.identity.get_device_id()?;
        let created = cloud.create_invitation(&device_id, ttl_seconds as u32)?;
        validate_created_invitation(&created, &device_id)?;

        let secret_bytes = crypto::b64_decode(&created.invitation_secret)?;
        if secret_bytes.len() != 16 {
            return Err(HubError::InvalidInvitation(
                "invitation secret must be 128-bit".into(),
            ));
        }
        self.store.insert_invitation(&StoredInvitation {
            invitation_id: created.invitation_id.clone(),
            issuer_device_id: created.issuer_device_id.clone(),
            invitation_secret_hash: crypto::sha256_hex(&secret_bytes),
            nonce: created.nonce.clone(),
            created_at: created.created_at.clone(),
            expires_at: created.expires_at.clone(),
            consumed_at: None,
            failed_attempts: 0,
            status: INVITATION_PENDING.into(),
        })?;

        let mut invitation = PairingInvitation {
            invitation_id: created.invitation_id,
            issuer_device_id: created.issuer_device_id,
            invitation_secret: created.invitation_secret,
            nonce: created.nonce,
            created_at: created.created_at,
            expires_at: created.expires_at,
            status: INVITATION_PENDING.into(),
            control_plane: cloud.base_url().to_string(),
            signature: String::new(),
            qr_payload: String::new(),
        };
        let (signature, payload) = self.sign_qr_payload(&invitation)?;
        invitation.signature = signature;
        invitation.qr_payload = payload;

        self.store.append_audit(
            "INVITATION_CREATED",
            None,
            Some(&invitation.invitation_id),
            Some(&self.identity.get_fingerprint()?),
            "OK",
            Some("ttlSeconds"),
            &crypto::now_iso8601_millis(),
        )?;
        Ok(invitation)
    }

    /// 生成 Base64URL(JSON) 二维码字符串（契约 §2）。
    /// 重新签名是确定性的（Ed25519），因此结果与创建时一致。
    pub fn render_qr_payload(&self, invitation: &PairingInvitation) -> HubResult<String> {
        let (signature, payload) = self.sign_qr_payload(invitation)?;
        if !invitation.signature.is_empty()
            && !crypto::ct_eq_str(&invitation.signature, &signature)
        {
            return Err(HubError::InvalidInvitation(
                "invitation signature does not match its fields".into(),
            ));
        }
        Ok(payload)
    }

    /// 本地校验邀请：存在、pending、未过期、nonce/secret 哈希一致、二维码签名自洽。
    pub fn validate_invitation(
        &self,
        invitation: &PairingInvitation,
    ) -> HubResult<InvitationClaims> {
        let stored = self
            .store
            .get_invitation(&invitation.invitation_id)?
            .ok_or_else(|| HubError::InvalidInvitation("unknown invitation".into()))?;
        let device_id = self.identity.get_device_id()?;
        if stored.issuer_device_id != device_id || invitation.issuer_device_id != device_id {
            return Err(HubError::Identity(
                "invitation was not issued by this Hub".into(),
            ));
        }
        if stored.status != INVITATION_PENDING || invitation.status != INVITATION_PENDING {
            return Err(HubError::InvalidInvitation(format!(
                "invitation is {}",
                stored.status
            )));
        }
        let now = crypto::now_iso8601_millis();
        if crypto::is_expired(&stored.expires_at, &now) {
            let _ = self.store.transition_invitation(
                &stored.invitation_id,
                INVITATION_EXPIRED,
                None,
            );
            let _ = self.store.append_audit(
                "INVITATION_EXPIRED",
                None,
                Some(&stored.invitation_id),
                None,
                "EXPIRED",
                None,
                &now,
            );
            return Err(HubError::InvalidInvitation("invitation expired".into()));
        }
        if !crypto::ct_eq_str(&stored.nonce, &invitation.nonce) {
            return Err(HubError::InvalidInvitation("invitation nonce mismatch".into()));
        }
        let secret = crypto::b64_decode(&invitation.invitation_secret)?;
        if secret.len() != 16
            || !crypto::ct_eq_str(&stored.invitation_secret_hash, &crypto::sha256_hex(&secret))
        {
            return Err(HubError::InvalidInvitation(
                "invitation secret mismatch".into(),
            ));
        }

        let identity = self.identity.load_identity()?;
        let envelope = self.decode_qr_payload(&invitation.qr_payload)?;
        let expected_cp = self
            .control_plane_url()
            .ok_or_else(|| HubError::Network("control plane not configured".into()))?;
        let fields_ok = envelope.v == PROTOCOL_VERSION
            && envelope.cp == expected_cp
            && envelope.cp == invitation.control_plane
            && envelope.iid == stored.invitation_id
            && envelope.sec == invitation.invitation_secret
            && envelope.nonce == stored.nonce
            && envelope.exp == stored.expires_at
            && envelope.hid == device_id
            && envelope.hpk == identity.public_key
            && crypto::ct_eq_str(&envelope.hfp, &identity.fingerprint);
        if !fields_ok {
            return Err(HubError::InvalidInvitation(
                "invitation payload does not match local record".into(),
            ));
        }
        let signable = canonical_signed_fields(&envelope)?;
        let public_key = identity.public_key_bytes()?;
        let signature = crypto::b64_decode(&envelope.sig)
            .map_err(|_| HubError::InvalidInvitation("invalid invitation signature".into()))?;
        crypto::verify_ed25519(&public_key, signable.as_bytes(), &signature)
            .map_err(|e| HubError::InvalidInvitation(format!("invitation signature: {}", e)))?;
        if !crypto::ct_eq_str(&envelope.sig, &invitation.signature) {
            return Err(HubError::InvalidInvitation(
                "invitation signature field was modified".into(),
            ));
        }

        Ok(InvitationClaims {
            invitation_id: stored.invitation_id,
            issuer_device_id: stored.issuer_device_id,
            nonce: stored.nonce,
            expires_at: stored.expires_at,
            fingerprint: identity.fingerprint,
        })
    }

    /// PC 拉取待批准申请（会缓存，供 `decide_pairing_request` 比对）。
    pub fn list_pending_requests(&self) -> HubResult<Vec<PendingPairingRequest>> {
        let cloud = self.require_cloud()?;
        let device_id = self.identity.get_device_id()?;
        let requests = cloud.list_pairing_requests(&device_id)?;
        let now = crypto::now_iso8601_millis();
        let mut fresh = Vec::new();
        let mut cache = self.pending_cache.lock();
        cache.clear();
        for request in requests {
            request.validate()?;
            if request.is_expired(&now) {
                continue;
            }
            cache.insert(request.request_id.clone(), request.clone());
            fresh.push(request);
        }
        Ok(fresh)
    }

    /// PC 本机批准/拒绝。只有批准才消费邀请并写本地设备表。
    pub fn decide_pairing_request(
        &self,
        request_id: &str,
        approved: bool,
    ) -> HubResult<PairingDecision> {
        Uuid::parse_str(request_id)
            .map_err(|_| HubError::InvalidInvitation("request id must be a UUID".into()))?;
        let cloud = self.require_cloud()?;
        let device_id = self.identity.get_device_id()?;

        // 批准前必须有「PC 已展示过」的申请；阻止绕过 UI 的直接批准，
        // 也防止云端在 list 与 decide 之间替换设备信息。
        let cached = if approved {
            Some(
                self.pending_cache
                    .lock()
                    .get(request_id)
                    .cloned()
                    .ok_or_else(|| {
                        HubError::InvalidInvitation(
                            "cannot approve a request that PC has not listed".into(),
                        )
                    })?,
            )
        } else {
            None
        };

        let outcome = cloud.decide_pairing_request(request_id, &device_id, approved)?;
        let now = crypto::now_iso8601_millis();

        if !approved {
            if outcome.status != "rejected" {
                return Err(HubError::InvalidInvitation(format!(
                    "cloud returned unexpected status {}",
                    outcome.status
                )));
            }
            self.pending_cache.lock().remove(request_id);
            self.store.append_audit(
                "PAIRING_REJECTED",
                cached.as_ref().map(|request| request.device_id.as_str()),
                Some(request_id),
                cached
                    .as_ref()
                    .map(|request| request.identity_fingerprint.as_str()),
                "rejected",
                None,
                &now,
            )?;
            return Ok(PairingDecision {
                status: "rejected".into(),
                device: None,
                capabilities: Vec::new(),
            });
        }

        let request = cached.expect("approved branch requires cached request");
        if outcome.status != "approved" {
            return Err(HubError::InvalidInvitation(format!(
                "cloud returned unexpected status {}",
                outcome.status
            )));
        }
        if request.is_expired(&now) {
            return Err(HubError::InvalidInvitation(
                "pairing request expired before approval".into(),
            ));
        }
        let cloud_device = outcome.device.as_ref().ok_or_else(|| {
            HubError::Identity("approved response is missing device identity".into())
        })?;
        if cloud_device.device_id != request.device_id
            || !crypto::ct_eq_str(
                &cloud_device.identity_fingerprint,
                &request.identity_fingerprint,
            )
            || cloud_device.identity_public_key != request.identity_public_key
        {
            self.store.append_audit(
                "SECURITY_FAILURE",
                Some(&request.device_id),
                Some(request_id),
                Some(&request.identity_fingerprint),
                "DENY",
                Some("APPROVAL_IDENTITY_MISMATCH"),
                &now,
            )?;
            return Err(HubError::Identity(
                "approved device differs from the request PC displayed".into(),
            ));
        }
        // 云端若声明 REMOTE_CONTROL，说明契约被破坏：记录安全事件，但本地
        // 仍只授予固定能力集（绝不因云端声明扩大权限）。
        if outcome
            .paired_capabilities
            .iter()
            .any(|capability| capability == REMOTE_CONTROL)
        {
            self.store.append_audit(
                "SECURITY_FAILURE",
                Some(&request.device_id),
                Some(request_id),
                Some(&request.identity_fingerprint),
                "DENY",
                Some("CAPABILITY_VIOLATION"),
                &now,
            )?;
        }

        let device = self.finalize_pairing(&request)?;
        self.pending_cache.lock().remove(request_id);
        self.store.append_audit(
            "PAIRING_APPROVED",
            Some(&device.device_id),
            Some(request_id),
            Some(&device.identity_fingerprint),
            "approved",
            None,
            &now,
        )?;
        Ok(PairingDecision {
            status: "approved".into(),
            capabilities: device.capabilities.clone(),
            device: Some(device),
        })
    }

    /// 批准后写入本地 `ph_devices`；能力集固定，不接受任何外部扩大。
    pub fn finalize_pairing(
        &self,
        request: &PendingPairingRequest,
    ) -> HubResult<PairedDevice> {
        request.validate()?;
        if request.is_expired(&crypto::now_iso8601_millis()) {
            return Err(HubError::InvalidInvitation(
                "pairing request expired before finalize".into(),
            ));
        }
        let device_id = self.devices.register_device(request.to_registration())?;
        let device = self
            .devices
            .get_device_by_id(&device_id)?
            .ok_or_else(|| HubError::Storage("paired device disappeared".into()))?;
        let expected: Vec<String> = PAIRED_CAPABILITIES
            .iter()
            .map(|value| (*value).to_string())
            .collect();
        if device.capabilities != expected
            || device
                .capabilities
                .iter()
                .any(|capability| capability == REMOTE_CONTROL)
        {
            return Err(HubError::PermissionDenied(
                "paired capabilities violated the fixed contract".into(),
            ));
        }
        Ok(device)
    }

    /// 本地作废邀请并写审计（幂等：已撤销返回 Ok）。
    pub fn revoke_invitation(&self, invitation_id: &str) -> HubResult<()> {
        let stored = self
            .store
            .get_invitation(invitation_id)?
            .ok_or_else(|| HubError::InvalidInvitation("unknown invitation".into()))?;
        if stored.status == INVITATION_REVOKED {
            return Ok(());
        }
        if stored.status != INVITATION_PENDING {
            return Err(HubError::InvalidInvitation(format!(
                "invitation is {}",
                stored.status
            )));
        }
        let now = crypto::now_iso8601_millis();
        if self
            .store
            .transition_invitation(invitation_id, INVITATION_REVOKED, None)?
        {
            self.store.append_audit(
                "INVITATION_REVOKED",
                None,
                Some(invitation_id),
                None,
                "revoked",
                None,
                &now,
            )?;
        }
        Ok(())
    }

    fn require_cloud(&self) -> HubResult<&Arc<dyn ControlPlane>> {
        self.cloud.as_ref().ok_or_else(|| {
            HubError::Network(
                self.cloud_error
                    .clone()
                    .unwrap_or_else(|| "control plane is not configured".into()),
            )
        })
    }

    fn sign_qr_payload(&self, invitation: &PairingInvitation) -> HubResult<(String, String)> {
        let mut fields = Map::new();
        fields.insert("v".into(), json!(PROTOCOL_VERSION));
        fields.insert("cp".into(), Value::String(invitation.control_plane.clone()));
        fields.insert("iid".into(), Value::String(invitation.invitation_id.clone()));
        fields.insert(
            "sec".into(),
            Value::String(invitation.invitation_secret.clone()),
        );
        fields.insert("nonce".into(), Value::String(invitation.nonce.clone()));
        fields.insert("exp".into(), Value::String(invitation.expires_at.clone()));
        fields.insert(
            "hid".into(),
            Value::String(invitation.issuer_device_id.clone()),
        );
        let identity = self.identity.load_identity()?;
        fields.insert("hpk".into(), Value::String(identity.public_key.clone()));
        fields.insert("hfp".into(), Value::String(identity.fingerprint.clone()));

        let signable = crypto::canonical_json(&Value::Object(fields.clone()))?;
        let signature = self.identity.sign_payload(signable.as_bytes())?;
        fields.insert(
            "sig".into(),
            Value::String(signature.to_base64()),
        );
        let payload = crypto::canonical_json(&Value::Object(fields))?;
        Ok((
            signature.to_base64(),
            crypto::b64url_encode(payload.as_bytes()),
        ))
    }

    fn decode_qr_payload(&self, payload: &str) -> HubResult<QrEnvelope> {
        let bytes = crypto::b64url_decode(payload)?;
        let text = String::from_utf8(bytes)
            .map_err(|_| HubError::InvalidInvitation("invitation is not UTF-8".into()))?;
        serde_json::from_str(&text)
            .map_err(|e| HubError::InvalidInvitation(format!("invalid invitation JSON: {}", e)))
    }
}

fn validate_created_invitation(
    created: &CreatedInvitation,
    issuer_device_id: &str,
) -> HubResult<()> {
    if created.issuer_device_id != issuer_device_id {
        return Err(HubError::Identity(
            "cloud created an invitation for another issuer".into(),
        ));
    }
    if created.status != INVITATION_PENDING {
        return Err(HubError::InvalidInvitation(
            "cloud invitation is not pending".into(),
        ));
    }
    if Uuid::parse_str(&created.invitation_id).is_err() || Uuid::parse_str(&created.nonce).is_err()
    {
        return Err(HubError::InvalidInvitation(
            "cloud invitation id/nonce must be UUIDs".into(),
        ));
    }
    let created_at = chrono::DateTime::parse_from_rfc3339(&created.created_at)
        .map_err(|_| HubError::InvalidInvitation("invalid created_at".into()))?;
    let expires_at = chrono::DateTime::parse_from_rfc3339(&created.expires_at)
        .map_err(|_| HubError::InvalidInvitation("invalid expires_at".into()))?;
    if expires_at <= created_at {
        return Err(HubError::InvalidInvitation(
            "invitation expiry must be after creation".into(),
        ));
    }
    Ok(())
}

fn canonical_signed_fields(envelope: &QrEnvelope) -> HubResult<String> {
    let mut fields = Map::new();
    fields.insert("v".into(), json!(envelope.v));
    fields.insert("cp".into(), Value::String(envelope.cp.clone()));
    fields.insert("iid".into(), Value::String(envelope.iid.clone()));
    fields.insert("sec".into(), Value::String(envelope.sec.clone()));
    fields.insert("nonce".into(), Value::String(envelope.nonce.clone()));
    fields.insert("exp".into(), Value::String(envelope.exp.clone()));
    fields.insert("hid".into(), Value::String(envelope.hid.clone()));
    fields.insert("hpk".into(), Value::String(envelope.hpk.clone()));
    fields.insert("hfp".into(), Value::String(envelope.hfp.clone()));
    crypto::canonical_json(&Value::Object(fields))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personal_hub::cloud::{CloudDevice, DecideOutcome};
    use crate::personal_hub::devices::{DEVICE_TYPE_ANDROID, PAIRED_CAPABILITIES};
    use ed25519_dalek::SigningKey;
    use std::collections::VecDeque;
    use std::path::PathBuf;

    struct MockCloud {
        base_url: String,
        invitations: Mutex<VecDeque<CreatedInvitation>>,
        pending: Mutex<Vec<PendingPairingRequest>>,
        decision: Mutex<Option<DecideOutcome>>,
    }

    impl MockCloud {
        fn new() -> Self {
            Self {
                base_url: "https://hub.example.com".into(),
                invitations: Mutex::new(VecDeque::new()),
                pending: Mutex::new(Vec::new()),
                decision: Mutex::new(None),
            }
        }
    }

    impl ControlPlane for MockCloud {
        fn base_url(&self) -> &str {
            &self.base_url
        }

        fn create_invitation(
            &self,
            issuer_device_id: &str,
            _ttl_seconds: u32,
        ) -> HubResult<CreatedInvitation> {
            let mut invitations = self.invitations.lock();
            let invitation = invitations
                .pop_front()
                .ok_or_else(|| HubError::Network("mock invitation queue is empty".into()))?;
            assert_eq!(invitation.issuer_device_id, issuer_device_id);
            Ok(invitation)
        }

        fn list_pairing_requests(
            &self,
            _issuer_device_id: &str,
        ) -> HubResult<Vec<PendingPairingRequest>> {
            Ok(self.pending.lock().clone())
        }

        fn decide_pairing_request(
            &self,
            _request_id: &str,
            _issuer_device_id: &str,
            approved: bool,
        ) -> HubResult<DecideOutcome> {
            if let Some(decision) = self.decision.lock().clone() {
                return Ok(decision);
            }
            Ok(DecideOutcome {
                status: if approved { "approved" } else { "rejected" }.into(),
                device: None,
                paired_capabilities: Vec::new(),
            })
        }
    }

    struct Harness {
        store: Arc<HubStore>,
        identity: Arc<IdentityManager>,
        devices: Arc<DeviceManager>,
        cloud: Arc<MockCloud>,
        pairing: PairingManager,
        dir: PathBuf,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn harness(tag: &str) -> Harness {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-ph-pairing-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = HubStore::open(dir.join("hub.db")).expect("open temp hub.db");
        let identity = Arc::new(IdentityManager::new(store.clone()));
        identity.load_identity().expect("identity");
        let devices = Arc::new(DeviceManager::new(store.clone()));
        let cloud = Arc::new(MockCloud::new());
        let cloud_trait: Arc<dyn ControlPlane> = cloud.clone();
        let pairing = PairingManager::new(
            store.clone(),
            identity.clone(),
            devices.clone(),
            Some(cloud_trait),
            None,
        );
        Harness {
            store,
            identity,
            devices,
            cloud,
            pairing,
            dir,
        }
    }

    fn invitation(issuer: &str, expires_at: &str) -> CreatedInvitation {
        CreatedInvitation {
            invitation_id: Uuid::new_v4().to_string(),
            issuer_device_id: issuer.to_string(),
            nonce: Uuid::new_v4().to_string(),
            created_at: crypto::now_iso8601_millis(),
            expires_at: expires_at.to_string(),
            status: "pending".into(),
            invitation_secret: crypto::b64_encode(&[0x42u8; 16]),
        }
    }

    fn future(minutes: i64) -> String {
        (chrono::Utc::now() + chrono::Duration::minutes(minutes))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn pending_for() -> PendingPairingRequest {
        let key = SigningKey::from_bytes(&[0x21u8; 32]);
        let public_key = key.verifying_key().to_bytes();
        PendingPairingRequest {
            request_id: Uuid::new_v4().to_string(),
            device_id: Uuid::new_v4().to_string(),
            device_type: DEVICE_TYPE_ANDROID.into(),
            display_name: "Pixel 8".into(),
            identity_fingerprint: crypto::fingerprint_of_public_key(&public_key).unwrap(),
            identity_public_key: crypto::b64_encode(&public_key),
            requested_at: crypto::now_iso8601_millis(),
            expires_at: future(5),
        }
    }

    #[test]
    fn invitation_round_trip_and_local_validation() {
        let h = harness("roundtrip");
        let issuer = h.identity.get_device_id().unwrap();
        h.cloud
            .invitations
            .lock()
            .push_back(invitation(&issuer, &future(5)));

        let invitation = h
            .pairing
            .create_pairing_invitation(Duration::from_secs(300))
            .expect("create invitation");
        assert!(!invitation.qr_payload.is_empty());
        // 二维码内部按契约含 sec 字段（邀请传递所必需），但绝不能含私钥/令牌字段。
        let decoded = String::from_utf8(
            crate::personal_hub::crypto::b64url_decode(&invitation.qr_payload).unwrap(),
        )
        .unwrap();
        assert!(decoded.contains(&invitation.invitation_secret));
        assert!(!decoded.contains("privateKey"));
        assert!(!decoded.contains("seed"));
        let claims = h
            .pairing
            .validate_invitation(&invitation)
            .expect("local validation");
        assert_eq!(claims.invitation_id, invitation.invitation_id);
        assert_eq!(
            h.pairing.render_qr_payload(&invitation).unwrap(),
            invitation.qr_payload
        );
    }

    #[test]
    fn invitation_expiry_is_detected_and_marked() {
        let h = harness("expiry");
        let issuer = h.identity.get_device_id().unwrap();
        h.cloud.invitations.lock().push_back(CreatedInvitation {
            created_at: (chrono::Utc::now() - chrono::Duration::minutes(10))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            expires_at: (chrono::Utc::now() - chrono::Duration::minutes(5))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            ..invitation(&issuer, &future(5))
        });
        let invitation = h
            .pairing
            .create_pairing_invitation(Duration::from_secs(300))
            .unwrap();
        assert!(matches!(
            h.pairing.validate_invitation(&invitation),
            Err(HubError::InvalidInvitation(_))
        ));
        let stored = h
            .store
            .get_invitation(&invitation.invitation_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.status, INVITATION_EXPIRED);
    }

    #[test]
    fn revoked_invitation_cannot_be_validated() {
        let h = harness("revoke");
        let issuer = h.identity.get_device_id().unwrap();
        h.cloud
            .invitations
            .lock()
            .push_back(invitation(&issuer, &future(5)));
        let invitation = h
            .pairing
            .create_pairing_invitation(Duration::from_secs(300))
            .unwrap();
        h.pairing
            .revoke_invitation(&invitation.invitation_id)
            .unwrap();
        assert!(matches!(
            h.pairing.validate_invitation(&invitation),
            Err(HubError::InvalidInvitation(_))
        ));
        // 幂等
        h.pairing
            .revoke_invitation(&invitation.invitation_id)
            .unwrap();
        assert_eq!(h.store.audit_count("INVITATION_REVOKED").unwrap(), 1);
    }

    #[test]
    fn tampered_qr_payload_is_rejected() {
        let h = harness("tamper-qr");
        let issuer = h.identity.get_device_id().unwrap();
        h.cloud
            .invitations
            .lock()
            .push_back(invitation(&issuer, &future(5)));
        let mut invitation = h
            .pairing
            .create_pairing_invitation(Duration::from_secs(300))
            .unwrap();
        // 篡改 Base64URL 载荷中的一个字符（保持长度）。
        let mut payload = invitation.qr_payload.clone();
        let index = payload.len() / 2;
        let replacement = if payload.as_bytes()[index] == b'A' { 'B' } else { 'A' };
        payload.replace_range(index..index + 1, &replacement.to_string());
        invitation.qr_payload = payload;
        assert!(matches!(
            h.pairing.validate_invitation(&invitation),
            Err(HubError::InvalidInvitation(_))
        ));
    }

    #[test]
    fn approval_grants_only_fixed_capabilities_even_if_cloud_claims_remote_control() {
        let h = harness("caps");
        let request = pending_for();
        *h.cloud.pending.lock() = vec![request.clone()];
        *h.cloud.decision.lock() = Some(DecideOutcome {
            status: "approved".into(),
            device: Some(CloudDevice {
                device_id: request.device_id.clone(),
                device_type: request.device_type.clone(),
                display_name: request.display_name.clone(),
                identity_public_key: request.identity_public_key.clone(),
                identity_fingerprint: request.identity_fingerprint.clone(),
            }),
            // 攻击模拟：云端错误声明 REMOTE_CONTROL。
            paired_capabilities: vec!["DEVICE_PAIRED".into(), "REMOTE_CONTROL".into()],
        });

        let listed = h.pairing.list_pending_requests().unwrap();
        assert_eq!(listed.len(), 1);
        let decision = h
            .pairing
            .decide_pairing_request(&request.request_id, true)
            .unwrap();
        assert_eq!(decision.status, "approved");
        let device = decision.device.expect("paired device");
        assert_eq!(
            device.capabilities,
            PAIRED_CAPABILITIES
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        );
        assert!(!device.capabilities.iter().any(|c| c == "REMOTE_CONTROL"));
        assert!(!decision
            .capabilities
            .iter()
            .any(|c| c == "REMOTE_CONTROL"));

        let stored = h.devices.list_paired_devices().unwrap();
        assert_eq!(stored.len(), 1);
        assert!(!stored[0].capabilities.iter().any(|c| c == "REMOTE_CONTROL"));
        // 云端契约违规被审计为安全事件。
        assert_eq!(h.store.audit_count("SECURITY_FAILURE").unwrap(), 1);
        assert_eq!(h.store.audit_count("PAIRING_APPROVED").unwrap(), 1);
    }

    #[test]
    fn approval_without_pc_listing_is_rejected() {
        let h = harness("no-list");
        let request = pending_for();
        *h.cloud.decision.lock() = Some(DecideOutcome {
            status: "approved".into(),
            device: Some(CloudDevice {
                device_id: request.device_id.clone(),
                device_type: request.device_type.clone(),
                display_name: request.display_name.clone(),
                identity_public_key: request.identity_public_key.clone(),
                identity_fingerprint: request.identity_fingerprint.clone(),
            }),
            paired_capabilities: vec![],
        });
        assert!(matches!(
            h.pairing.decide_pairing_request(&request.request_id, true),
            Err(HubError::InvalidInvitation(_))
        ));
        assert!(h.devices.list_paired_devices().unwrap().is_empty());
    }

    #[test]
    fn rejection_does_not_create_device_or_consume_invitation() {
        let h = harness("reject");
        let request = pending_for();
        *h.cloud.pending.lock() = vec![request.clone()];
        *h.cloud.decision.lock() = Some(DecideOutcome {
            status: "rejected".into(),
            device: None,
            paired_capabilities: vec![],
        });
        h.pairing.list_pending_requests().unwrap();
        let decision = h
            .pairing
            .decide_pairing_request(&request.request_id, false)
            .unwrap();
        assert_eq!(decision.status, "rejected");
        assert!(decision.device.is_none());
        assert!(h.devices.list_paired_devices().unwrap().is_empty());
        assert_eq!(h.store.audit_count("PAIRING_REJECTED").unwrap(), 1);
    }

    #[test]
    fn approval_rejects_identity_swap_between_list_and_decide() {
        let h = harness("swap");
        let request = pending_for();
        *h.cloud.pending.lock() = vec![request.clone()];
        h.pairing.list_pending_requests().unwrap();

        let other_key = SigningKey::from_bytes(&[0x31u8; 32]);
        let other_public = other_key.verifying_key().to_bytes();
        *h.cloud.decision.lock() = Some(DecideOutcome {
            status: "approved".into(),
            device: Some(CloudDevice {
                device_id: request.device_id.clone(),
                device_type: request.device_type.clone(),
                display_name: "Evil".into(),
                identity_public_key: crypto::b64_encode(&other_public),
                identity_fingerprint: crypto::fingerprint_of_public_key(&other_public).unwrap(),
            }),
            paired_capabilities: vec![],
        });
        assert!(matches!(
            h.pairing.decide_pairing_request(&request.request_id, true),
            Err(HubError::Identity(_))
        ));
        assert!(h.devices.list_paired_devices().unwrap().is_empty());
    }
}
