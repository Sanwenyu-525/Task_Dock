//! 剪贴板静态加密基础设施（Phase 1）：CEK、DPAPI 信封、字段/资产编解码。
//!
//! 安全边界（与 `docs/adr/0012-clipboard-static-encryption.md` 一致）：
//! - 剪贴板使用**独立随机 CEK**，不复用保险箱 DEK/KEK，不读取保险箱会话；
//! - CEK 只以 **DPAPI 当前用户作用域**封装态落库（不传 `CRYPTPROTECT_LOCAL_MACHINE`，
//!   `CRYPTPROTECT_UI_FORBIDDEN`，应用专属 entropy），同机其他用户无法解封装；
//! - 明文 CEK 只存在于 `Zeroizing` 内存，进程退出清零；信封不含明文密钥；
//! - 密文带版本前缀，旧明文原样透传（双读兼容），便于分批迁移；
//! - 未知密文版本一律报错，绝不把“看起来是密文”的内容当明文展示。
//!
//! 本模块只提供原语与信封生命周期，不改变现有读写路径；采集/读取链路接入、
//! 历史迁移与备份加密在后续阶段单独实施。信封随 `application_settings` 参与备份，
//! 因此在备份加密（BEK）落地前，跨设备恢复无法解封装——该约束在 ADR §8 已登记。

use std::sync::{Mutex, OnceLock};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine as _;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 信封在 `application_settings` 中的键。
pub const ENVELOPE_SETTING_KEY: &str = "clipboard_crypto_envelope";
pub const ENVELOPE_FORMAT: &str = "tdclip-cek-envelope";
pub const ENVELOPE_VERSION: u32 = 1;
/// 字段密文版本前缀；格式为 `tdcl1:<b64 nonce>:<b64 ciphertext>`。
const FIELD_PREFIX_V1: &str = "tdcl1:";
/// 所有已知字段前缀的公共头，用于拒绝“未知版本的密文被当明文”。
const FIELD_FAMILY: &str = "tdcl";
/// 资产密文容器魔数（7 字节），后接 12 字节 nonce 与密文。
const BLOB_MAGIC: &[u8] = b"TDCLB1\x00";
/// DPAPI 用途区分（非密钥，仅隔离用途，防同用户其它程序密文被挪用）。
const DPAPI_ENTROPY: &[u8] = b"TaskDock.Clipboard.CEK.v1";
const KEK_KIND_DPAPI_USER: &str = "dpapi-user";
const ENTROPY_ID: &str = "taskdock-clipboard-cek-v1";

/// 密钥信封：只存封装态 CEK 与参数，不含明文密钥、KDF 秘密或主密码。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CekEnvelope {
    pub format: String,
    pub version: u32,
    /// CEK 代数：轮换时递增，旧密文仍按自身代理解密语（本期只读校验，不自动轮换）。
    pub cek_ver: u32,
    /// 密钥保护方式：当前固定 `dpapi-user`。
    pub kek: String,
    /// DPAPI entropy 标识，用于诊断与未来迁移，不含秘密。
    pub entropy_id: String,
    pub ciphertext_b64: String,
    pub created_at: String,
}

/// `(信封指纹, CEK)` 进程内缓存：指纹变化（轮换/换库）时自动失效。
static CEK_CACHE: OnceLock<Mutex<Option<([u8; 32], Zeroizing<[u8; 32]>)>>> = OnceLock::new();
/// 信封首次创建时的串行化锁，避免并发写出两套 CEK 导致一半数据不可解。
static ENVELOPE_LOCK: Mutex<()> = Mutex::new(());

fn cache() -> &'static Mutex<Option<([u8; 32], Zeroizing<[u8; 32]>)>> {
    CEK_CACHE.get_or_init(|| Mutex::new(None))
}

fn rng_fill(buf: &mut [u8]) -> AppResult<()> {
    OsRng
        .try_fill_bytes(buf)
        .map_err(|e| AppError::Unavailable(format!("剪贴板加密随机数不可用: {e}")))
}

fn random_array<const N: usize>() -> AppResult<[u8; N]> {
    let mut out = [0u8; N];
    rng_fill(&mut out)?;
    Ok(out)
}

fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64_decode(raw: &str) -> AppResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|_| AppError::Validation("剪贴板密文编码损坏".into()))
}

fn cipher(cek: &[u8; 32]) -> AppResult<Aes256Gcm> {
    Aes256Gcm::new_from_slice(cek)
        .map_err(|_| AppError::Validation("剪贴板加密密钥长度无效".into()))
}

fn seal_parts(cek: &[u8; 32], aad: &str, plaintext: &[u8]) -> AppResult<([u8; 12], Vec<u8>)> {
    let cipher = cipher(cek)?;
    let nonce = random_array::<12>()?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| AppError::Unavailable("剪贴板数据加密失败".into()))?;
    Ok((nonce, ct))
}

fn open_parts(cek: &[u8; 32], aad: &str, nonce: &[u8], ct: &[u8]) -> AppResult<Vec<u8>> {
    let nonce: &[u8; 12] = nonce
        .try_into()
        .map_err(|_| AppError::Validation("剪贴板密文 nonce 长度无效".into()))?;
    let cipher = cipher(cek)?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ct,
                aad: aad.as_bytes(),
            },
        )
        // 认证失败统一文案：不区分“密钥错误/被篡改/记录搬移”，避免给攻击者反馈。
        .map_err(|_| AppError::Validation("剪贴板密文校验失败（密钥不匹配或数据被篡改）".into()))
}

/// 条目字段 AAD：绑定记录类型与条目 UUID，禁止跨条目/跨字段搬运密文。
pub fn item_field_aad(item_id: &str, field: &str) -> String {
    format!("tdclip|field|{field}|{item_id}|v1")
}

/// 资产文件 AAD：绑定条目 UUID 与角色（原图/缩略图/预览缓存）。
pub fn item_asset_aad(item_id: &str, role: &str) -> String {
    format!("tdclip|asset|{role}|{item_id}|v1")
}

/// 是否为本模块产出的字段密文。
pub fn is_encrypted_field(value: &str) -> bool {
    value.starts_with(FIELD_FAMILY)
}

/// 字段加密：返回 `tdcl1:<nonce>:<ct>`；空明文同样加密（保留“存在且为空”的事实）。
pub fn encrypt_field(cek: &[u8; 32], aad: &str, plaintext: &str) -> AppResult<String> {
    let (nonce, ct) = seal_parts(cek, aad, plaintext.as_bytes())?;
    Ok(format!(
        "{FIELD_PREFIX_V1}{}:{}",
        b64_encode(&nonce),
        b64_encode(&ct)
    ))
}

/// 字段解密：旧明文（无前缀）原样返回，保证迁移前数据可读。
pub fn decrypt_field(cek: &[u8; 32], aad: &str, stored: &str) -> AppResult<String> {
    if !is_encrypted_field(stored) {
        return Ok(stored.to_string());
    }
    let body = stored
        .strip_prefix(FIELD_PREFIX_V1)
        .ok_or_else(|| AppError::Validation("剪贴板密文版本不受支持".into()))?;
    let (nonce_b64, ct_b64) = body
        .split_once(':')
        .ok_or_else(|| AppError::Validation("剪贴板密文结构损坏".into()))?;
    let nonce = b64_decode(nonce_b64)?;
    let ct = b64_decode(ct_b64)?;
    let plain = open_parts(cek, aad, &nonce, &ct)?;
    String::from_utf8(plain).map_err(|_| AppError::Validation("剪贴板密文内容不是有效文本".into()))
}

/// 资产/二进制是否为本模块产出的密文容器。
pub fn is_encrypted_blob(bytes: &[u8]) -> bool {
    bytes.len() >= BLOB_MAGIC.len() && &bytes[..BLOB_MAGIC.len()] == BLOB_MAGIC
}

/// 资产加密：`magic(7) | nonce(12) | ciphertext`。
pub fn encrypt_bytes(cek: &[u8; 32], aad: &str, plaintext: &[u8]) -> AppResult<Vec<u8>> {
    let (nonce, ct) = seal_parts(cek, aad, plaintext)?;
    let mut out = Vec::with_capacity(BLOB_MAGIC.len() + nonce.len() + ct.len());
    out.extend_from_slice(BLOB_MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 资产解密：旧明文 PNG（无魔数）原样返回，保证迁移前图片可读。
pub fn decrypt_bytes(cek: &[u8; 32], aad: &str, stored: &[u8]) -> AppResult<Zeroizing<Vec<u8>>> {
    if !is_encrypted_blob(stored) {
        return Ok(Zeroizing::new(stored.to_vec()));
    }
    let rest = &stored[BLOB_MAGIC.len()..];
    if rest.len() < 12 {
        return Err(AppError::Validation("剪贴板资产密文结构损坏".into()));
    }
    let (nonce, ct) = rest.split_at(12);
    Ok(Zeroizing::new(open_parts(cek, aad, nonce, ct)?))
}

// ── DPAPI 封装（当前用户作用域）─────────────────────────────

#[cfg(windows)]
fn dpapi_protect(plaintext: &[u8]) -> AppResult<Vec<u8>> {
    use std::ptr;

    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if plaintext.is_empty() {
        return Err(AppError::Validation("剪贴板密钥为空".into()));
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: DPAPI_ENTROPY.len() as u32,
        pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
    };
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
        return Err(AppError::Unavailable(format!(
            "剪贴板密钥封装失败（DPAPI 错误 {})",
            unsafe { GetLastError() }
        )));
    }
    if output.pbData.is_null() || output.cbData == 0 {
        return Err(AppError::Unavailable("剪贴板密钥封装返回空密文".into()));
    }
    let ciphertext =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    // DPAPI 用 LocalAlloc 分配输出，必须 LocalFree，否则每次调用泄漏一块内存。
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(ciphertext)
}

#[cfg(windows)]
fn dpapi_unprotect(ciphertext: &[u8]) -> AppResult<Zeroizing<Vec<u8>>> {
    use std::ptr;

    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if ciphertext.is_empty() {
        return Err(AppError::Validation("剪贴板密钥信封为空".into()));
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: DPAPI_ENTROPY.len() as u32,
        pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
    };
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
        // 其他 Windows 用户、被篡改的信封、DPAPI 主密钥损坏都会落到这里：fail closed。
        return Err(AppError::Unavailable(format!(
            "剪贴板加密密钥不可用（DPAPI 解封装失败 {}）",
            unsafe { GetLastError() }
        )));
    }
    if output.pbData.is_null() || output.cbData == 0 {
        return Err(AppError::Unavailable("剪贴板密钥解封装返回空明文".into()));
    }
    let plain = Zeroizing::new(
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() },
    );
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(plain)
}

#[cfg(not(windows))]
fn dpapi_protect(_plaintext: &[u8]) -> AppResult<Vec<u8>> {
    Err(AppError::Unavailable(
        "剪贴板加密仅支持 Windows DPAPI；当前平台不提供密钥保护".into(),
    ))
}

#[cfg(not(windows))]
fn dpapi_unprotect(_ciphertext: &[u8]) -> AppResult<Zeroizing<Vec<u8>>> {
    Err(AppError::Unavailable(
        "剪贴板加密仅支持 Windows DPAPI；当前平台不提供密钥保护".into(),
    ))
}

// ── 信封生命周期 ────────────────────────────────────────────

/// 读取已存在的信封；缺失返回 `None`，格式/版本不符报错（不静默重建）。
pub fn load_envelope(db: &Db) -> AppResult<Option<CekEnvelope>> {
    let Some(raw) = db.get_setting(ENVELOPE_SETTING_KEY)? else {
        return Ok(None);
    };
    if raw.is_null() {
        return Err(AppError::Validation("剪贴板密钥信封已损坏".into()));
    }
    let env: CekEnvelope = serde_json::from_value(raw)
        .map_err(|_| AppError::Validation("剪贴板密钥信封结构损坏".into()))?;
    if env.format != ENVELOPE_FORMAT {
        return Err(AppError::Validation("剪贴板密钥信封标识不符".into()));
    }
    if env.version != ENVELOPE_VERSION {
        return Err(AppError::Validation(format!(
            "剪贴板密钥信封版本不受支持: {}",
            env.version
        )));
    }
    if env.kek != KEK_KIND_DPAPI_USER {
        return Err(AppError::Validation("剪贴板密钥保护方式不受支持".into()));
    }
    if env.ciphertext_b64.is_empty() {
        return Err(AppError::Validation("剪贴板密钥信封缺少密文".into()));
    }
    Ok(Some(env))
}

/// 确保信封存在（缺则生成随机 CEK 并 DPAPI 封装）。
///
/// 并发安全：创建段在 `ENVELOPE_LOCK` 内二次检查，避免两套 CEK 各加密一半数据。
pub fn ensure_envelope(db: &Db) -> AppResult<CekEnvelope> {
    if let Some(env) = load_envelope(db)? {
        return Ok(env);
    }
    let _guard = ENVELOPE_LOCK
        .lock()
        .map_err(|_| AppError::Unavailable("剪贴板密钥信封锁不可用".into()))?;
    if let Some(env) = load_envelope(db)? {
        return Ok(env);
    }
    let cek = Zeroizing::new(random_array::<32>()?);
    let ciphertext = dpapi_protect(cek.as_ref())?;
    let env = CekEnvelope {
        format: ENVELOPE_FORMAT.to_string(),
        version: ENVELOPE_VERSION,
        cek_ver: 1,
        kek: KEK_KIND_DPAPI_USER.to_string(),
        entropy_id: ENTROPY_ID.to_string(),
        ciphertext_b64: b64_encode(&ciphertext),
        created_at: crate::agents::now_iso(),
    };
    db.set_setting(ENVELOPE_SETTING_KEY, serde_json::json!(env))?;
    Ok(env)
}

/// 信封指纹：用于缓存失效判定（只哈希封装态密文，不含明文密钥）。
fn envelope_fingerprint(env: &CekEnvelope) -> AppResult<[u8; 32]> {
    let raw = serde_json::to_vec(env)?;
    Ok(Sha256::digest(raw).into())
}

/// 取得本进程可用的 CEK 副本（解封装并按信封指纹缓存）。
///
/// 调用方负责不把返回值写入磁盘/日志；`Zeroizing` 在离开作用域时清零。
pub fn cek(db: &Db) -> AppResult<Zeroizing<[u8; 32]>> {
    let env = ensure_envelope(db)?;
    let fingerprint = envelope_fingerprint(&env)?;
    if let Ok(cache) = cache().lock() {
        if let Some((cached_fp, cached_cek)) = cache.as_ref() {
            if cached_fp == &fingerprint {
                return Ok(Zeroizing::new(**cached_cek));
            }
        }
    }
    let ciphertext = b64_decode(&env.ciphertext_b64)?;
    let plain = dpapi_unprotect(&ciphertext)?;
    if plain.len() != 32 {
        return Err(AppError::Validation("剪贴板加密密钥长度无效".into()));
    }
    let mut cek = Zeroizing::new([0u8; 32]);
    cek.copy_from_slice(&plain);
    if let Ok(mut cache) = cache().lock() {
        *cache = Some((fingerprint, Zeroizing::new(*cek)));
    }
    Ok(cek)
}

/// 清空进程内 CEK 缓存（测试、轮换或锁定场景使用）。
pub fn reset_cache() {
    if let Ok(mut cache) = cache().lock() {
        *cache = None;
    }
}

/// 测试共用锁：CEK 进程缓存是全局的，`secure`/`store`/迁移用例并行跑会互相清空密钥。
#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

/// 读取进程内已加载的 CEK（不解封装、不创建信封）。
fn cached_cek() -> Option<Zeroizing<[u8; 32]>> {
    cache()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|(_, key)| Zeroizing::new(**key)))
}

/// 启动时把已存在的信封加载进进程缓存；信封不存在时保持为空（不创建密钥）。
///
/// 只读取已落库信封：明文历史库在没有信封时不需要任何密钥，也不会因为本调用
/// 凭空产生加密状态。
pub fn prime_cache(db: &Db) -> AppResult<()> {
    let Some(env) = load_envelope(db)? else {
        return Ok(());
    };
    let fingerprint = envelope_fingerprint(&env)?;
    if let Ok(cache) = cache().lock() {
        if let Some((cached_fp, _)) = cache.as_ref() {
            if cached_fp == &fingerprint {
                return Ok(());
            }
        }
    }
    let ciphertext = b64_decode(&env.ciphertext_b64)?;
    let plain = dpapi_unprotect(&ciphertext)?;
    if plain.len() != 32 {
        return Err(AppError::Validation("剪贴板加密密钥长度无效".into()));
    }
    let mut cek = Zeroizing::new([0u8; 32]);
    cek.copy_from_slice(&plain);
    if let Ok(mut cache) = cache().lock() {
        *cache = Some((fingerprint, Zeroizing::new(*cek)));
    }
    Ok(())
}

/// 读取兼容解密：无密文前缀的旧明文原样返回；有前缀但密钥未加载时 fail-closed。
///
/// 该函数供行映射等无 `&Db` 的读取路径使用，密钥来自 `prime_cache` 或加密写入时的
/// 进程缓存；绝不把密文当明文返回。
pub fn decrypt_if_encrypted(aad: &str, stored: &str) -> AppResult<String> {
    if !is_encrypted_field(stored) {
        return Ok(stored.to_string());
    }
    let key = cached_cek().ok_or_else(|| {
        AppError::Unavailable("剪贴板加密密钥未加载，无法读取已加密的剪贴板历史".into())
    })?;
    decrypt_field(&key, aad, stored)
}

/// 写入侧加密：开关关闭时保持明文（迁移前行为）；开启时缺信封会先创建 CEK。
///
/// 创建/解封装失败一律向上返回，调用方不得降级为明文落库。
pub fn encrypt_for_write(
    db: &Db,
    enabled: bool,
    aad: &str,
    plaintext: &str,
) -> AppResult<String> {
    if !enabled {
        return Ok(plaintext.to_string());
    }
    let key = cek(db)?;
    encrypt_field(&key, aad, plaintext)
}

/// 是否已有可用的进程内 CEK（决定派生缓存是否加密写入）。
pub fn has_cached_key() -> bool {
    cached_cek().is_some()
}

/// 派生缓存写入：有可用 CEK 时加密，否则保持明文（迁移前行为）。
///
/// 与历史数据不同，预览缓存属可重建派生数据：缺密钥时不阻塞读取路径，
/// 但一旦密钥可用，后续缓存写入即为密文。
pub fn maybe_encrypt_blob(aad: &str, bytes: &[u8]) -> AppResult<Vec<u8>> {
    match cached_cek() {
        Some(key) => encrypt_bytes(&key, aad, bytes),
        None => Ok(bytes.to_vec()),
    }
}

/// 二进制读取兼容解密：旧明文资产原样返回；密文缺密钥时 fail-closed。
pub fn decrypt_blob_if_encrypted(aad: &str, stored: &[u8]) -> AppResult<Zeroizing<Vec<u8>>> {
    if !is_encrypted_blob(stored) {
        return Ok(Zeroizing::new(stored.to_vec()));
    }
    let key = cached_cek().ok_or_else(|| {
        AppError::Unavailable("剪贴板加密密钥未加载，无法读取已加密的图片资产".into())
    })?;
    decrypt_bytes(&key, aad, stored)
}

/// 该信封能否被当前 Windows 用户解封装（诊断/迁移前置检查，不解明文）。
pub fn envelope_is_usable(db: &Db) -> AppResult<bool> {
    match load_envelope(db)? {
        None => Ok(false),
        Some(env) => {
            let ciphertext = b64_decode(&env.ciphertext_b64)?;
            Ok(dpapi_unprotect(&ciphertext).is_ok())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("td-clip-sec-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            reset_cache();
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const SENTINEL: &str = "TDCLIP-SENTINEL-9f3a2c";

    fn field_roundtrip_is_stable() {
        let cek = [7u8; 32];
        let aad = item_field_aad("item-1", "text");
        let stored = encrypt_field(&cek, &aad, SENTINEL).unwrap();
        assert!(is_encrypted_field(&stored));
        assert!(!stored.contains(SENTINEL));
        assert_eq!(decrypt_field(&cek, &aad, &stored).unwrap(), SENTINEL);
    }

    #[test]
    fn field_roundtrip_is_stable_by_default() {
        field_roundtrip_is_stable();
    }

    #[test]
    fn empty_plaintext_still_encrypts() {
        let cek = [3u8; 32];
        let aad = item_field_aad("item-empty", "html");
        let stored = encrypt_field(&cek, &aad, "").unwrap();
        assert!(is_encrypted_field(&stored));
        assert_eq!(decrypt_field(&cek, &aad, &stored).unwrap(), "");
    }

    #[test]
    fn legacy_plaintext_passes_through() {
        let cek = [5u8; 32];
        let aad = item_field_aad("legacy", "text");
        // 迁移前数据没有前缀：必须原样可读，不能报错或显示为密文。
        assert_eq!(
            decrypt_field(&cek, &aad, "普通历史文本").unwrap(),
            "普通历史文本"
        );
        assert_eq!(decrypt_field(&cek, &aad, "").unwrap(), "");
    }

    #[test]
    fn wrong_cek_or_aad_fails_closed() {
        let cek = [9u8; 32];
        let other = [10u8; 32];
        let aad = item_field_aad("item-2", "text");
        let stored = encrypt_field(&cek, &aad, SENTINEL).unwrap();

        assert!(decrypt_field(&other, &aad, &stored).is_err());
        // 跨字段/跨条目搬运密文必须被 AAD 拒绝。
        assert!(decrypt_field(&cek, &item_field_aad("item-2", "preview"), &stored).is_err());
        assert!(decrypt_field(&cek, &item_field_aad("item-3", "text"), &stored).is_err());
        assert!(decrypt_field(&cek, &item_asset_aad("item-2", "thumb"), &stored).is_err());
    }

    #[test]
    fn tampered_ciphertext_rejected() {
        let cek = [11u8; 32];
        let aad = item_field_aad("item-3", "text");
        let stored = encrypt_field(&cek, &aad, SENTINEL).unwrap();
        let mut chars: Vec<char> = stored.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == 'A' { 'B' } else { 'A' };
        let tampered: String = chars.into_iter().collect();
        assert!(decrypt_field(&cek, &aad, &tampered).is_err());
    }

    #[test]
    fn unknown_version_is_refused_not_shown_as_plaintext() {
        let cek = [13u8; 32];
        let aad = item_field_aad("item-4", "text");
        // 未来版本前缀必须报错：不能把密文当正文展示。
        let err = decrypt_field(&cek, &aad, "tdcl2:abc:def").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert!(decrypt_field(&cek, &aad, "tdcl1:broken").is_err());
    }

    #[test]
    fn blob_roundtrip_and_legacy_png_passthrough() {
        let cek = [17u8; 32];
        let aad = item_asset_aad("img-1", "image");
        let png = b"\x89PNG\r\n\x1a\nfake-image-bytes".to_vec();
        let stored = encrypt_bytes(&cek, &aad, &png).unwrap();
        assert!(is_encrypted_blob(&stored));
        assert!(!stored.windows(png.len()).any(|w| w == png.as_slice()));
        assert_eq!(
            decrypt_bytes(&cek, &aad, &stored).unwrap().as_slice(),
            png.as_slice()
        );
        // 迁移前的明文 PNG 没有魔数，必须原样返回。
        assert!(!is_encrypted_blob(&png));
        assert_eq!(
            decrypt_bytes(&cek, &aad, &png).unwrap().as_slice(),
            png.as_slice()
        );
    }

    #[test]
    fn blob_with_wrong_aad_or_truncated_rejected() {
        let cek = [19u8; 32];
        let aad = item_asset_aad("img-2", "thumb");
        let stored = encrypt_bytes(&cek, &aad, b"thumb-bytes").unwrap();
        assert!(decrypt_bytes(&cek, &item_asset_aad("img-2", "image"), &stored).is_err());
        assert!(decrypt_bytes(&cek, &aad, &stored[..BLOB_MAGIC.len() + 4]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn envelope_is_created_once_and_reused() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let first = ensure_envelope(&db).unwrap();
        let second = ensure_envelope(&db).unwrap();
        assert_eq!(first.ciphertext_b64, second.ciphertext_b64, "并发创建必须复用同一 CEK");
        assert_eq!(first.format, ENVELOPE_FORMAT);
        assert_eq!(first.version, ENVELOPE_VERSION);
        assert_eq!(first.kek, KEK_KIND_DPAPI_USER);
        assert!(!first.ciphertext_b64.is_empty());
        assert!(envelope_is_usable(&db).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn cek_is_stable_and_cached() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let a = cek(&db).unwrap();
        let b = cek(&db).unwrap();
        assert_eq!(a.as_ref(), b.as_ref());
        reset_cache();
        let c = cek(&db).unwrap();
        assert_eq!(a.as_ref(), c.as_ref(), "解封装必须得到同一 CEK");
    }

    #[cfg(windows)]
    #[test]
    fn ciphertext_never_embeds_plaintext_sentinel() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let key = cek(&db).unwrap();
        let stored = encrypt_field(&key, &item_field_aad("i", "text"), SENTINEL).unwrap();
        assert!(!stored.contains(SENTINEL));
        let env = load_envelope(&db).unwrap().unwrap();
        // 信封只含封装态；即便把密文 base64 解回来，也不得出现明文密钥。
        let raw = b64_decode(&env.ciphertext_b64).unwrap();
        assert!(!raw.windows(32).any(|w| w == key.as_ref()));
    }

    #[cfg(windows)]
    #[test]
    fn corrupted_envelope_is_refused_without_silent_rebuild() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        ensure_envelope(&db).unwrap();
        db.set_setting(ENVELOPE_SETTING_KEY, serde_json::json!({"format":"wrong"}))
            .unwrap();
        reset_cache();
        assert!(load_envelope(&db).is_err(), "损坏信封必须报错，不得静默重建");
        assert!(cek(&db).is_err());
    }
}
