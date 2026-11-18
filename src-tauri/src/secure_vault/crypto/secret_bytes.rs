//! 编码工具：Base64（信封字段）与 Crockford Base32（恢复密钥）。

use base32::Alphabet;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

use crate::secure_vault::error::VaultError;

pub fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, VaultError> {
    B64.decode(s).map_err(|_| VaultError::corrupt())
}

/// 20 字节 → 32 个 Crockford 字符。
pub fn encode_recovery(bytes: &[u8; 20]) -> String {
    base32::encode(Alphabet::Crockford, bytes)
}

/// 显示为 8 组 × 4 字符，便于抄写。
pub fn recovery_groups(code: &str) -> Vec<String> {
    code.as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).to_string())
        .collect()
}

/// 解析用户输入：忽略分隔符与大小写，按 Crockford 规则纠正 I/L/O。
pub fn parse_recovery(input: &str) -> Result<[u8; 20], VaultError> {
    let mut normalized = String::with_capacity(32);
    for ch in input.chars() {
        if ch.is_whitespace() || ch == '-' || ch == '_' {
            continue;
        }
        let up = ch.to_ascii_uppercase();
        let mapped = match up {
            'I' | 'L' => '1',
            'O' => '0',
            _ => up,
        };
        normalized.push(mapped);
    }
    if normalized.len() != 32 {
        return Err(VaultError::bad_recovery_key());
    }
    let bytes = base32::decode(Alphabet::Crockford, &normalized)
        .ok_or_else(VaultError::bad_recovery_key)?;
    if bytes.len() != 20 {
        return Err(VaultError::bad_recovery_key());
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    // 重新编码必须与规范化输入一致，防止非规范编码被接受。
    if encode_recovery(&out) != normalized {
        return Err(VaultError::bad_recovery_key());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_vault::crypto::random_array;

    #[test]
    fn recovery_roundtrip_is_32_chars_and_8_groups() {
        let bytes: [u8; 20] = random_array().unwrap();
        let code = encode_recovery(&bytes);
        assert_eq!(code.len(), 32);
        assert_eq!(recovery_groups(&code).len(), 8);
        let parsed = parse_recovery(&code).unwrap();
        assert_eq!(parsed, bytes);
    }

    #[test]
    fn recovery_accepts_hyphens_and_confusable_letters() {
        let bytes: [u8; 20] = random_array().unwrap();
        let code = encode_recovery(&bytes);
        let messy = code
            .chars()
            .map(|c| match c {
                '0' => 'O',
                '1' => 'l',
                _ => c,
            })
            .collect::<Vec<_>>()
            .chunks(4)
            .map(|c| c.iter().collect::<String>())
            .collect::<Vec<_>>()
            .join("-");
        assert_eq!(parse_recovery(&messy).unwrap(), bytes);
    }

    #[test]
    fn recovery_rejects_wrong_length() {
        assert!(parse_recovery("ABC").is_err());
    }
}
