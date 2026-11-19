//! Windows DPAPI 封装（当前用户作用域）。
//!
//! 安全边界（基线 §6.1 / 契约 §1）：
//! - 只使用 `CryptProtectData` / `CryptUnprotectData` 的**当前用户**作用域；
//!   绝不传 `CRYPTPROTECT_LOCAL_MACHINE`，因此密文不能被同机其他用户解密。
//! - `CRYPTPROTECT_UI_FORBIDDEN`：后台进程不弹任何系统对话框，失败即 fail closed。
//! - 附加固定 entropy，绑定到 TaskDock Personal Hub 身份用途，避免同一用户下
//!   其它程序的密文被直接挪用。
//!
//! 明文只在调用栈内的 `Vec<u8>` 中存在；调用方负责在使用后用 `zeroize` 清零。

use std::ptr;

use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

use crate::personal_hub::error::{HubError, HubResult};

/// 应用上下文 entropy（非密钥，只用于隔离用途）。
const ENTROPY: &[u8] = b"TaskDock.PersonalHub.DeviceIdentity.v1";

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    }
}

unsafe fn take_output(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if out.pbData.is_null() || out.cbData == 0 {
        return Vec::new();
    }
    let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
    // DPAPI 用 LocalAlloc 分配输出，必须 LocalFree，否则每次调用泄漏一块内存。
    LocalFree(out.pbData as *mut core::ffi::c_void);
    bytes
}

/// 用当前 Windows 用户作用域加密（不落盘、不打印）。
pub fn protect(plaintext: &[u8]) -> HubResult<Vec<u8>> {
    if plaintext.is_empty() {
        return Err(HubError::Storage("DPAPI: empty plaintext".into()));
    }
    let input = blob(plaintext);
    let entropy = blob(ENTROPY);
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            &entropy,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(HubError::Storage(format!(
            "CryptProtectData failed: {}",
            unsafe { GetLastError() }
        )));
    }
    let ciphertext = unsafe { take_output(output) };
    if ciphertext.is_empty() {
        return Err(HubError::Storage(
            "CryptProtectData returned empty ciphertext".into(),
        ));
    }
    Ok(ciphertext)
}

/// 用当前 Windows 用户作用域解密；失败（含其他用户密文）一律拒绝。
pub fn unprotect(ciphertext: &[u8]) -> HubResult<Vec<u8>> {
    if ciphertext.is_empty() {
        return Err(HubError::Storage("DPAPI: empty ciphertext".into()));
    }
    let input = blob(ciphertext);
    let entropy = blob(ENTROPY);
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            &entropy,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(HubError::Storage(format!(
            "CryptUnprotectData failed: {}",
            unsafe { GetLastError() }
        )));
    }
    let plaintext = unsafe { take_output(output) };
    if plaintext.is_empty() {
        return Err(HubError::Storage(
            "CryptUnprotectData returned empty plaintext".into(),
        ));
    }
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeroize::Zeroizing;

    #[test]
    fn protect_unprotect_round_trip() {
        let secret = Zeroizing::new(b"taskdock-dpapi-round-trip-0123456789".to_vec());
        let ciphertext = protect(&secret).expect("DPAPI protect");
        assert_ne!(ciphertext.as_slice(), secret.as_slice());
        let plaintext = Zeroizing::new(unprotect(&ciphertext).expect("DPAPI unprotect"));
        assert_eq!(plaintext.as_slice(), secret.as_slice());
    }

    #[test]
    fn ciphertext_does_not_contain_plaintext() {
        let secret = b"TASKDOCK-PRIVATE-KEY-MARKER-32BYTES!!";
        let ciphertext = protect(secret).expect("DPAPI protect");
        assert!(
            !ciphertext.windows(secret.len()).any(|w| w == secret),
            "DPAPI ciphertext must not embed plaintext"
        );
    }

    #[test]
    fn rejects_empty_input() {
        assert!(protect(&[]).is_err());
        assert!(unprotect(&[]).is_err());
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let mut ciphertext = protect(b"identity-seed").expect("DPAPI protect");
        let last = ciphertext.len() - 1;
        ciphertext[last] ^= 0xff;
        assert!(unprotect(&ciphertext).is_err());
    }
}
