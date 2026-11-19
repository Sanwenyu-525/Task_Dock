//! Personal Hub 密码学/编码基线（P3，契约 §1）。
//!
//! - Ed25519 签名（实现见 `identity`，本模块只提供编码与规范化）；
//! - 公钥/签名 base64（标准字母表 + `=` 填充）；
//! - 指纹：`hex(sha256(raw 32-byte public key))[0..32]`（小写）；
//! - canonical JSON：对象键按字典序、数组保序、UTF-8，用于签名载荷。
//!
//! 云端参考实现：`services/personal-hub-control-plane/src/schema/canonical.ts`。
//! 本实现必须与它对齐；契约 §5 的固定向量在 `tests` 中固化。

pub mod dpapi;

use base64::Engine as _;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::personal_hub::error::{HubError, HubResult};

/// 标准 base64 编码（契约 §1：公钥/签名均使用标准字母表并带填充）。
pub fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// 标准 base64 解码；非法输入按身份错误处理（fail closed）。
pub fn b64_decode(value: &str) -> HubResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|e| HubError::Identity(format!("invalid base64: {}", e)))
}

/// URL 安全 base64（二维码载荷使用）。
pub fn b64url_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE.encode(bytes)
}

/// URL 安全 base64 解码。
pub fn b64url_decode(value: &str) -> HubResult<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE
        .decode(value)
        .map_err(|e| HubError::InvalidInvitation(format!("invalid base64url: {}", e)))
}

/// 小写十六进制（指纹、secret 哈希）。
pub fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

/// `hex(sha256(bytes))` 小写。
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex_lower(&digest)
}

/// 校验 Ed25519 签名（RFC 8032，`verify_strict` 拒绝弱公钥/可延展签名）。
pub fn verify_ed25519(public_key: &[u8], payload: &[u8], signature: &[u8]) -> HubResult<()> {
    if public_key.len() != 32 {
        return Err(HubError::Identity(format!(
            "public key must be 32 bytes, got {}",
            public_key.len()
        )));
    }
    let key_bytes: [u8; 32] = public_key
        .try_into()
        .map_err(|_| HubError::Identity("public key conversion failed".into()))?;
    let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&key_bytes)
        .map_err(|e| HubError::Identity(format!("invalid public key: {}", e)))?;
    let signature = ed25519_dalek::Signature::from_slice(signature)
        .map_err(|e| HubError::Identity(format!("invalid signature encoding: {}", e)))?;
    verifying_key
        .verify_strict(payload, &signature)
        .map_err(|e| HubError::Identity(format!("signature verification failed: {}", e)))
}

/// 指纹规则：`hex(sha256(raw32 pubkey))[0..32]`。
pub fn fingerprint_of_public_key(public_key: &[u8]) -> HubResult<String> {
    if public_key.len() != 32 {
        return Err(HubError::Identity(format!(
            "public key must be 32 raw bytes, got {}",
            public_key.len()
        )));
    }
    let hex = sha256_hex(public_key);
    Ok(hex[..32].to_string())
}

/// 常量时间字符串比较（邀请 secret 哈希、指纹等）。
pub fn ct_eq_str(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// UTC ISO-8601（毫秒）——契约 §1 的 `2026-11-19T04:05:06.000Z` 形式。
pub fn now_iso8601_millis() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 判断 UTC ISO-8601 时间是否已过期（无法解析按过期处理，fail closed）。
pub fn is_expired(expires_at: &str, now: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(expires_at),
        chrono::DateTime::parse_from_rfc3339(now),
    ) {
        (Ok(expires), Ok(now)) => expires <= now,
        _ => true,
    }
}

/// canonical JSON 序列化（契约 §1 / §5）。
///
/// 与云端 `canonicalStringify` 一致：对象键按字典序、数组保序、剔除
/// `undefined`（`serde_json::Value` 不存在该值），`null` 保留。
///
/// 数值只接受整数。契约载荷（版本号、TTL）均为整数；浮点数直接拒绝，
/// 避免 Rust（`1.0`）与 JS（`1`）序列化差异造成跨端签名不一致。
pub fn canonical_json(value: &Value) -> HubResult<String> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

fn write_canonical(value: &Value, out: &mut String) -> HubResult<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            if let Some(i) = number.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = number.as_u64() {
                out.push_str(&u.to_string());
            } else {
                return Err(HubError::Identity(
                    "canonical JSON does not support non-integer numbers".into(),
                ));
            }
        }
        Value::String(text) => {
            let escaped = serde_json::to_string(text)
                .map_err(|e| HubError::Identity(format!("json string encode failed: {}", e)))?;
            out.push_str(&escaped);
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => write_canonical_object(map, out)?,
    }
    Ok(())
}

fn write_canonical_object(map: &Map<String, Value>, out: &mut String) -> HubResult<()> {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    out.push('{');
    for (index, key) in keys.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let escaped = serde_json::to_string(key)
            .map_err(|e| HubError::Identity(format!("json key encode failed: {}", e)))?;
        out.push_str(&escaped);
        out.push(':');
        write_canonical(&map[*key], out)?;
    }
    out.push('}');
    Ok(())
}

/// 从对象中剔除 `signature` 后生成签名载荷（契约 §1）。
pub fn signable_payload(map: &Map<String, Value>) -> HubResult<String> {
    let mut rest = map.clone();
    rest.remove("signature");
    canonical_json(&Value::Object(rest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 契约 §5 固定向量：三端必须逐字节一致。
    #[test]
    fn canonical_json_contract_vector() {
        let input = json!({"b": 1, "a": "x", "nested": {"z": true, "y": [3, 2, 1]}});
        let expected = r#"{"a":"x","b":1,"nested":{"y":[3,2,1],"z":true}}"#;
        assert_eq!(canonical_json(&input).unwrap(), expected);
    }

    #[test]
    fn canonical_json_rejects_floats() {
        let input = json!({"v": 1.5});
        assert!(canonical_json(&input).is_err());
    }

    #[test]
    fn signable_payload_removes_only_signature() {
        let input = json!({"b": 1, "signature": "abc", "a": "x"});
        let map = input.as_object().unwrap().clone();
        assert_eq!(signable_payload(&map).unwrap(), r#"{"a":"x","b":1}"#);
    }

    #[test]
    fn fingerprint_rule_matches_contract() {
        // 32 字节 0x01 公钥的 sha256 前 32 个十六进制字符（node:crypto 复核）。
        let fingerprint = fingerprint_of_public_key(&[1u8; 32]).unwrap();
        assert_eq!(fingerprint, "72cd6e8422c407fb6d098690f1130b7d");
        assert_eq!(fingerprint.len(), 32);
    }

    #[test]
    fn fingerprint_rejects_wrong_key_length() {
        assert!(fingerprint_of_public_key(&[1u8; 31]).is_err());
    }

    #[test]
    fn ct_eq_is_length_safe() {
        assert!(ct_eq_str("abc", "abc"));
        assert!(!ct_eq_str("abc", "abd"));
        assert!(!ct_eq_str("abc", "ab"));
    }

    #[test]
    fn base64_round_trip() {
        let bytes = [0u8, 1, 2, 250, 255];
        assert_eq!(b64_decode(&b64_encode(&bytes)).unwrap(), bytes);
        assert_eq!(b64url_decode(&b64url_encode(&bytes)).unwrap(), bytes);
    }
}
