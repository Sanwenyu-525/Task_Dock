//! 手机接入 v2 的 TLS 身份：持久自签证书 + SPKI SHA-256 指纹。
//!
//! 设计约束：
//! - **纯 Rust 生成证书**（rsa + x509-cert）：本机构建没有 nasm/cmake，
//!   不能依赖 ring/aws-lc-rs 系列；握手本身走系统 schannel（native-tls）。
//! - 证书为 RSA-3072 自签（SHA-256 签名），CN=TaskDock Mobile Sync，有效期 10 年。
//!   不用 ECDSA 的原因：native-tls 的 Windows 后端经 legacy CryptoAPI
//!   （ProviderType::rsa_full）导入私钥，不支持 EC 密钥（实测
//!   「ASN1 遇到了不正确的标记值」），RSA 是该路径唯一可行算法；
//!   SPKI 指纹固定语义与密钥算法无关。
//! - 首次启用时生成，落盘 `<data_dir>/mobile_tls/`（cert.pem + key.pem），
//!   不进数据库迁移、不进备份。剩余有效期不足 30 天时整体轮换。
//! - 服务端身份 = 证书 SPKI（SubjectPublicKeyInfo DER）的 SHA-256，64 位小写 hex。
//!   手机端自定义 TrustManager 只信任「SPKI 指纹 == 配对码二维码里固定值」的证书，
//!   不依赖系统根证书库；Java `certificate.publicKey.encoded` 即同一份 SPKI DER。
//! - 私钥与证书绝不写日志；指纹是公开值，可以进二维码与状态接口。

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use rand::RngCore;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::EncodePrivateKey;
use rsa::signature::Keypair;
use sha2::{Digest, Sha256};
use x509_cert::builder::{Builder, CertificateBuilder, Profile};
use x509_cert::der::{DecodePem, Encode, EncodePem};
use x509_cert::name::Name;
use x509_cert::serial_number::SerialNumber;
use x509_cert::spki::SubjectPublicKeyInfoOwned;
use x509_cert::time::Validity;

/// 自签证书 RSA 密钥长度。3072 位在纯 Rust 生成（约 1–3 秒，仅首次）与
/// 手机端低频连接场景下都可接受；2048 位不满足长期证书（10 年）的余量。
const RSA_KEY_BITS: usize = 3072;
/// 自签证书有效期：10 年。指纹固定后证书轮换必然导致已配对设备重配，
/// 因此按「尽量长」处理，到期前 30 天整体轮换并要求重新配对。
const CERT_LIFETIME_DAYS: u64 = 3650;
/// 剩余有效期低于该值时轮换证书（重建文件，指纹变化，手机端需重新配对）。
const RENEWAL_WINDOW: Duration = Duration::from_secs(30 * 24 * 3600);
/// 证书目录与文件名（相对 data_dir）。
pub const TLS_DIR_NAME: &str = "mobile_tls";
pub(crate) const CERT_FILE: &str = "cert.pem";
const KEY_FILE: &str = "key.pem";

/// 可直接用于监听的 TLS 身份。
#[derive(Clone)]
pub struct TlsIdentity {
    acceptor: tokio_native_tls::TlsAcceptor,
    /// SPKI SHA-256，64 位小写 hex。公开值：进二维码、状态接口与日志（指纹本身可记录）。
    fingerprint: String,
}

impl TlsIdentity {
    pub fn acceptor(&self) -> tokio_native_tls::TlsAcceptor {
        self.acceptor.clone()
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

/// 加载或创建 TLS 身份；失败返回错误描述（fail-closed，不允许明文回退）。
pub fn load_or_create(data_dir: &Path) -> Result<TlsIdentity, String> {
    let dir = data_dir.join(TLS_DIR_NAME);
    let cert_path = dir.join(CERT_FILE);
    let key_path = dir.join(KEY_FILE);

    if let (Ok(cert_pem), Ok(key_pem)) = (
        std::fs::read_to_string(&cert_path),
        std::fs::read_to_string(&key_path),
    ) {
        match identity_from_pem(&cert_pem, &key_pem) {
            Ok(identity) => {
                // 剩余有效期不足（或文件被外部改动成过期证书）时整体轮换。
                if cert_renewal_needed(&cert_pem) {
                    tracing::info!("手机接入 TLS 证书临近到期，生成新证书（已配对设备需重新配对）");
                } else {
                    return Ok(identity);
                }
            }
            Err(error) => {
                // 文件损坏/被篡改：重建而不是带病运行；不把密钥或证书内容写日志。
                tracing::warn!("手机接入 TLS 证书文件不可用，重新生成: {error}");
            }
        }
    }

    let (cert_pem, key_pem) = generate_self_signed().map_err(|e| {
        format!("生成自签证书失败: {e}")
    })?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建 TLS 证书目录失败（{}）: {e}", dir.display()))?;
    // 先写证书再写密钥：两步之间失败会留下没有私钥的证书，下次整体重建。
    std::fs::write(&cert_path, &cert_pem)
        .map_err(|e| format!("写入 TLS 证书失败（{}）: {e}", cert_path.display()))?;
    std::fs::write(&key_path, &key_pem)
        .map_err(|e| format!("写入 TLS 私钥失败（{}）: {e}", key_path.display()))?;

    let identity =
        identity_from_pem(&cert_pem, &key_pem).map_err(|e| format!("新证书不可用: {e}"))?;
    tracing::info!("手机接入 TLS：已生成自签证书，SPKI 指纹 {}", identity.fingerprint());
    Ok(identity)
}

fn identity_from_pem(cert_pem: &str, key_pem: &str) -> Result<TlsIdentity, String> {
    let certificate = native_tls::Identity::from_pkcs8(cert_pem.as_bytes(), key_pem.as_bytes())
        .map_err(|e| format!("native-tls 导入身份失败: {e}"))?;
    let fingerprint = spki_fingerprint_from_cert_pem(cert_pem)?;
    Ok(TlsIdentity {
        acceptor: tokio_native_tls::TlsAcceptor::from(
            native_tls::TlsAcceptor::builder(certificate)
                .build()
                .map_err(|e| format!("构建 TLS acceptor 失败: {e}"))?,
        ),
        fingerprint,
    })
}

/// 生成 RSA-3072 自签证书（SHA-256 签名），返回 (cert_pem, key_pem)。
fn generate_self_signed() -> Result<(String, String), String> {
    let mut rng = rand::rngs::OsRng;
    let private_key = rsa::RsaPrivateKey::new(&mut rng, RSA_KEY_BITS)
        .map_err(|e| format!("生成 RSA 密钥失败: {e}"))?;
    let signing_key = SigningKey::<Sha256>::new(private_key);

    // 序列号：16 随机字节，最高位清零保证 DER 正整数。
    let mut serial_bytes = [0u8; 16];
    rng.fill_bytes(&mut serial_bytes);
    serial_bytes[0] &= 0x7f;
    if serial_bytes[0] == 0 {
        serial_bytes[0] = 0x01;
    }

    let subject = Name::from_str("CN=TaskDock Mobile Sync")
        .map_err(|e| format!("构造证书主体失败: {e}"))?;
    let validity = Validity::from_now(Duration::from_secs(CERT_LIFETIME_DAYS * 24 * 3600))
        .map_err(|e| format!("构造证书有效期失败: {e}"))?;

    let builder = CertificateBuilder::new(
        Profile::Root,
        SerialNumber::new(&serial_bytes).map_err(|e| format!("构造证书序列号失败: {e}"))?,
        validity,
        subject,
        SubjectPublicKeyInfoOwned::from_key(signing_key.verifying_key())
            .map_err(|e| format!("构造证书公钥失败: {e}"))?,
        &signing_key,
    )
    .map_err(|e| format!("构造证书失败: {e}"))?;
    let cert = builder
        .build::<rsa::pkcs1v15::Signature>()
        .map_err(|e| format!("签发证书失败: {e}"))?;

    let cert_pem = cert
        .to_pem(x509_cert::der::pem::LineEnding::LF)
        .map_err(|e| format!("证书转 PEM 失败: {e}"))?;
    let key_pem = signing_key
        .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
        .map_err(|e| format!("私钥转 PEM 失败: {e}"))?
        .to_string();
    Ok((cert_pem, key_pem))
}

/// SPKI（SubjectPublicKeyInfo DER）的 SHA-256，小写 hex。手机端 Kotlin
/// `certificate.publicKey.encoded` 就是同一份 DER，两边算法一致。
pub fn spki_fingerprint(spki_der: &[u8]) -> String {
    let digest = Sha256::digest(spki_der);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn spki_fingerprint_from_cert_pem(cert_pem: &str) -> Result<String, String> {
    let cert =
        x509_cert::Certificate::from_pem(cert_pem).map_err(|e| format!("证书 PEM 解析失败: {e}"))?;
    let spki = &cert.tbs_certificate.subject_public_key_info;
    let spki_der = spki
        .to_der()
        .map_err(|e| format!("SPKI DER 编码失败: {e}"))?;
    Ok(spki_fingerprint(&spki_der))
}

/// 证书剩余有效期是否已低于轮换窗口；解析失败按「需要重建」处理。
fn cert_renewal_needed(cert_pem: &str) -> bool {
    let Ok(cert) = x509_cert::Certificate::from_pem(cert_pem) else {
        return true;
    };
    // 0.2.5 的 Time::to_unix_duration 直接返回 Duration（无 Result 包装）。
    let not_after = cert.tbs_certificate.validity.not_after.to_unix_duration();
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return true;
    };
    not_after.saturating_sub(now) <= RENEWAL_WINDOW
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("taskdock-mobile-tls-test")
            .join(format!("{tag}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn generates_loadable_identity_with_stable_fingerprint() {
        let dir = temp_dir("stable");
        let first = load_or_create(&dir).unwrap();
        assert_eq!(first.fingerprint().len(), 64);
        assert!(first
            .fingerprint()
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));

        // 重新加载：同一文件必须得到同一指纹（持久身份）。
        let second = load_or_create(&dir).unwrap();
        assert_eq!(first.fingerprint(), second.fingerprint());

        // PEM 文件真实存在且可解析。
        let cert_pem = std::fs::read_to_string(dir.join(TLS_DIR_NAME).join(CERT_FILE)).unwrap();
        assert!(cert_pem.starts_with("-----BEGIN CERTIFICATE-----"));
        let key_pem = std::fs::read_to_string(dir.join(TLS_DIR_NAME).join(KEY_FILE)).unwrap();
        assert!(key_pem.starts_with("-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn corrupted_files_are_regenerated() {
        let dir = temp_dir("corrupt");
        let first = load_or_create(&dir).unwrap();
        std::fs::write(dir.join(TLS_DIR_NAME).join(KEY_FILE), "not a key").unwrap();
        let second = load_or_create(&dir).unwrap();
        assert_ne!(first.fingerprint(), second.fingerprint());
    }

    #[test]
    fn fingerprint_matches_spki_of_signing_key() {
        let dir = temp_dir("spki");
        let identity = load_or_create(&dir).unwrap();
        let cert_pem =
            std::fs::read_to_string(dir.join(TLS_DIR_NAME).join(CERT_FILE)).unwrap();
        // 独立路径：从证书解析 SPKI，重算指纹，必须与身份上的指纹一致。
        let cert = x509_cert::Certificate::from_pem(&cert_pem).unwrap();
        let spki = &cert.tbs_certificate.subject_public_key_info;
        assert_eq!(
            identity.fingerprint(),
            spki_fingerprint(spki.to_der().unwrap().as_slice())
        );
        // 证书主体与算法抽查。
        assert!(cert
            .tbs_certificate
            .subject
            .to_string()
            .contains("TaskDock"));
    }
}
