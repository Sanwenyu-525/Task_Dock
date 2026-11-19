//! Hub 本地管理 API：把身份/配对/设备能力暴露给 P1 Named Pipe（P3）。
//!
//! 协议：JSON 行（message-mode 管道，一次请求/一次响应）。
//! 请求：`{"id": <可选>, "method": "pairing.create_invitation", "params": { ... }}`
//! 响应：`{"id": ..., "ok": true, "result": ...}` /
//!       `{"id": ..., "ok": false, "error": {"code": "...", "message": "..."}}`
//!
//! 兼容 P1 的纯文本命令（PING/STATUS/STOP）由 `named_pipe` 直接处理；本层只处理
//! 新方法。**不提供私钥导出/任意载荷签名接口**，防止本地管道变成签名预言机。

use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::personal_hub::cloud::{ControlPlane, HttpControlPlane};
use crate::personal_hub::devices::DeviceManager;
use crate::personal_hub::error::{HubError, HubResult};
use crate::personal_hub::identity::IdentityManager;
use crate::personal_hub::ipc::PipeHandler;
use crate::personal_hub::pairing::PairingManager;
use crate::personal_hub::store::{self, HubStore};
use crate::personal_hub::types::HubConfig;

pub const ENV_CONTROL_PLANE_URL: &str = "TASKDOCK_PH_CONTROL_PLANE_URL";

pub struct HubApi {
    identity: Arc<IdentityManager>,
    devices: Arc<DeviceManager>,
    pairing: Arc<PairingManager>,
}

impl HubApi {
    /// 打开 Hub 数据目录、初始化/加载身份，并按 `HubConfig` 构造云端客户端。
    /// 不读取环境变量（供单元测试/嵌入式调用，行为确定）。
    pub fn open(config: &HubConfig) -> HubResult<Arc<Self>> {
        Self::open_inner(config, None)
    }

    /// 独立进程入口使用：在 `HubConfig.control_plane_url` 未指定时回退
    /// `TASKDOCK_PH_CONTROL_PLANE_URL`。
    pub fn open_with_env(config: &HubConfig) -> HubResult<Arc<Self>> {
        let env_url = std::env::var(ENV_CONTROL_PLANE_URL).ok();
        Self::open_inner(config, env_url)
    }

    /// 打开 Hub 数据目录；云端未配置或配置非法时，身份与设备管理仍可用，
    /// 配对方法返回明确错误。
    fn open_inner(config: &HubConfig, env_url: Option<String>) -> HubResult<Arc<Self>> {
        let data_dir = match &config.data_dir {
            Some(dir) => dir.clone(),
            None => store::default_data_dir()?,
        };
        let store = HubStore::open(data_dir.join("hub.db"))?;
        let identity = Arc::new(IdentityManager::new(store.clone()));
        // 首次运行在此生成身份；失败必须阻止 Hub 启动（fail closed）。
        identity.load_identity()?;
        let devices = Arc::new(DeviceManager::new(store.clone()));

        let url = config
            .control_plane_url
            .clone()
            .or(env_url)
            .filter(|value| !value.trim().is_empty());

        let (cloud, cloud_error): (Option<Arc<dyn ControlPlane>>, Option<String>) = match url {
            Some(url) => match HttpControlPlane::new(&url, identity.clone()) {
                Ok(client) => (Some(Arc::new(client)), None),
                Err(err) => (
                    None,
                    Some(format!("control plane configuration rejected: {}", err)),
                ),
            },
            None => (
                None,
                Some("control plane is not configured (set TASKDOCK_PH_CONTROL_PLANE_URL)".into()),
            ),
        };
        if let Some(error) = &cloud_error {
            // 只记录配置状态，不输出任何密钥/secret。配对调用会返回同一错误。
            eprintln!("taskdock-personal-hub: {}", error);
        }

        let pairing = Arc::new(PairingManager::new(
            store,
            identity.clone(),
            devices.clone(),
            cloud,
            cloud_error,
        ));
        Ok(Arc::new(Self {
            identity,
            devices,
            pairing,
        }))
    }

    pub fn identity(&self) -> &Arc<IdentityManager> {
        &self.identity
    }

    pub fn devices(&self) -> &Arc<DeviceManager> {
        &self.devices
    }

    pub fn pairing(&self) -> &Arc<PairingManager> {
        &self.pairing
    }

    /// 处理一条请求（纯文本方法名或 JSON 行），返回 JSON 字符串。
    pub fn handle_request(&self, request: &str) -> String {
        let trimmed = request.trim();
        if trimmed.is_empty() {
            return error_response(None, "EMPTY_REQUEST", "empty request");
        }

        if trimmed.starts_with('{') {
            let parsed: Value = match serde_json::from_str(trimmed) {
                Ok(value) => value,
                Err(e) => {
                    return error_response(None, "INVALID_JSON", &format!("invalid JSON: {}", e))
                }
            };
            let id = parsed.get("id").cloned();
            let method = match parsed.get("method").and_then(Value::as_str) {
                Some(method) => method,
                None => return error_response(id, "INVALID_REQUEST", "missing method"),
            };
            let empty = Value::Object(Map::new());
            let params = parsed.get("params").unwrap_or(&empty);
            if !params.is_object() && !params.is_null() {
                return error_response(id, "INVALID_REQUEST", "params must be an object");
            }
            return self.dispatch_response(id, method, params);
        }

        if trimmed.contains('.') {
            return self.dispatch_response(None, trimmed, &Value::Object(Map::new()));
        }
        error_response(None, "UNKNOWN_COMMAND", "unknown command")
    }

    fn dispatch_response(&self, id: Option<Value>, method: &str, params: &Value) -> String {
        match self.dispatch(method, params) {
            Ok(result) => success_response(id, result),
            Err(err) => {
                let (code, message) = error_code(&err);
                error_response(id, code, &message)
            }
        }
    }

    fn dispatch(&self, method: &str, params: &Value) -> HubResult<Value> {
        match method {
            "identity.get_public" => {
                let identity = self.identity.load_identity()?;
                Ok(serde_json::to_value(identity).map_err(|e| {
                    HubError::Storage(format!("serialize identity failed: {}", e))
                })?)
            }
            "pairing.create_invitation" => {
                let ttl_seconds = match params.get("ttlSeconds") {
                    None | Some(Value::Null) => 300,
                    Some(value) => value.as_u64().ok_or_else(|| {
                        HubError::InvalidInvitation("ttlSeconds must be an integer".into())
                    })?,
                };
                let invitation = self
                    .pairing
                    .create_pairing_invitation(std::time::Duration::from_secs(ttl_seconds))?;
                Ok(json!({
                    "invitationId": invitation.invitation_id,
                    "qrPayload": invitation.qr_payload,
                    "expiresAt": invitation.expires_at,
                    "nonce": invitation.nonce,
                    "status": invitation.status,
                }))
            }
            "pairing.list_pending" => {
                let requests = self.pairing.list_pending_requests()?;
                let requests = serde_json::to_value(requests).map_err(|e| {
                    HubError::Storage(format!("serialize pairing requests failed: {}", e))
                })?;
                Ok(json!({ "requests": requests }))
            }
            "pairing.decide" => {
                let request_id = required_str(params, "requestId")?;
                let approved = params
                    .get("approved")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        HubError::InvalidInvitation("approved must be a boolean".into())
                    })?;
                let decision = self.pairing.decide_pairing_request(request_id, approved)?;
                Ok(serde_json::to_value(decision).map_err(|e| {
                    HubError::Storage(format!("serialize pairing decision failed: {}", e))
                })?)
            }
            "devices.list" => {
                let devices = serde_json::to_value(self.devices.list_paired_devices()?)
                    .map_err(|e| HubError::Storage(format!("serialize devices failed: {}", e)))?;
                Ok(json!({ "devices": devices }))
            }
            "devices.revoke" => {
                let device_id = required_str(params, "deviceId")?;
                let reason = required_str(params, "reason")?;
                self.devices.revoke_device(device_id, reason)?;
                Ok(json!({ "deviceId": device_id, "revoked": true }))
            }
            other => Err(HubError::InvalidSession(format!(
                "unknown method: {}",
                other
            ))),
        }
    }
}

impl PipeHandler for HubApi {
    fn handle(&self, request: &str) -> String {
        self.handle_request(request)
    }
}

fn required_str<'a>(params: &'a Value, key: &str) -> HubResult<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| HubError::InvalidSession(format!("{} is required", key)))
}

fn success_response(id: Option<Value>, result: Value) -> String {
    let mut out = Map::new();
    if let Some(id) = id {
        out.insert("id".into(), id);
    }
    out.insert("ok".into(), Value::Bool(true));
    out.insert("result".into(), result);
    Value::Object(out).to_string()
}

fn error_response(id: Option<Value>, code: &str, message: &str) -> String {
    let mut out = Map::new();
    if let Some(id) = id {
        out.insert("id".into(), id);
    }
    out.insert("ok".into(), Value::Bool(false));
    out.insert(
        "error".into(),
        json!({ "code": code, "message": message }),
    );
    Value::Object(out).to_string()
}

fn error_code(err: &HubError) -> (&'static str, String) {
    match err {
        HubError::InvalidInvitation(message) => ("INVALID_INVITATION", message.clone()),
        HubError::Identity(message) => ("IDENTITY_MISMATCH", message.clone()),
        HubError::DeviceRevoked => ("DEVICE_REVOKED", "device revoked".into()),
        HubError::PermissionDenied(message) => ("PERMISSION_DENIED", message.clone()),
        HubError::InvalidSession(message) => ("INVALID_REQUEST", message.clone()),
        HubError::Network(message) => ("NETWORK_ERROR", message.clone()),
        HubError::Storage(message) => ("STORAGE_ERROR", message.clone()),
        HubError::LocalAuthRequired => ("LOCAL_AUTH_REQUIRED", "local authentication required".into()),
        HubError::LocalAuthFailed(message) => ("LOCAL_AUTH_FAILED", message.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct ApiFixture {
        api: Arc<HubApi>,
        dir: PathBuf,
    }

    impl Drop for ApiFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture(tag: &str) -> ApiFixture {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-ph-api-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config = HubConfig {
            data_dir: Some(dir.clone()),
            control_plane_url: None,
            ..HubConfig::default()
        };
        let api = HubApi::open(&config).expect("open HubApi");
        ApiFixture { api, dir }
    }

    fn parse(response: &str) -> Value {
        serde_json::from_str(response).expect("response must be JSON")
    }

    #[test]
    fn identity_get_public_returns_no_private_material() {
        let f = fixture("identity");
        let response = parse(&f.api.handle_request(r#"{"id":1,"method":"identity.get_public"}"#));
        assert_eq!(response["ok"], true);
        assert_eq!(response["id"], 1);
        let result = &response["result"];
        assert!(result["deviceId"].as_str().unwrap().len() >= 36);
        assert_eq!(result["publicKey"].as_str().unwrap().len(), 44);
        assert_eq!(result["fingerprint"].as_str().unwrap().len(), 32);
        let text = response.to_string().to_ascii_lowercase();
        assert!(!text.contains("private"));
        assert!(!text.contains("seed"));
    }

    #[test]
    fn devices_list_is_empty_initially() {
        let f = fixture("devices");
        let response = parse(&f.api.handle_request("devices.list"));
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["devices"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn pairing_without_cloud_returns_explicit_error() {
        let f = fixture("no-cloud");
        let response = parse(&f.api.handle_request(
            r#"{"method":"pairing.create_invitation","params":{"ttlSeconds":300}}"#,
        ));
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "NETWORK_ERROR");
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not configured"));
    }

    #[test]
    fn unknown_method_and_bad_json_are_rejected() {
        let f = fixture("errors");
        let response = parse(&f.api.handle_request(r#"{"method":"nope"}"#));
        assert_eq!(response["error"]["code"], "INVALID_REQUEST");
        let response = parse(&f.api.handle_request("{not json"));
        assert_eq!(response["error"]["code"], "INVALID_JSON");
        let response = parse(&f.api.handle_request(""));
        assert_eq!(response["error"]["code"], "EMPTY_REQUEST");
    }

    #[test]
    fn devices_revoke_requires_existing_device() {
        let f = fixture("revoke");
        let response = parse(&f.api.handle_request(
            r#"{"method":"devices.revoke","params":{"deviceId":"77777777-7777-4777-8777-777777777777","reason":"user"}}"#,
        ));
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "IDENTITY_MISMATCH");
    }
}
