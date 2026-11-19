// Ed25519（RFC 8032）密钥生成/签名/验签与指纹计算。
//
// 为什么用 BouncyCastle 轻量 API 而不是 JCA：
// - AndroidKeyStore 的 Ed25519 只在 API 33+ 提供，本项目 minSdk 24；
// - BC 的 lightweight API 不注册 Provider、不改全局安全配置，也不参与 TLS；
// - 输出与 node:crypto / ed25519-dalek 完全一致（契约 §1、§5 的跨端签名向量）。
//
// 安全边界：
// - 私钥只以 32 字节 seed 形式存在，调用方负责用后 Arrays.fill(seed, 0)；
// - 本类不打印、不缓存 seed，也不把 seed 写入任何异常消息；
// - 指纹固定为 SHA-256(raw 32B public key) 的小写 hex 前 32 字符（契约 §1）。
package dev.taskdock.modules.deviceidentity

import java.security.MessageDigest
import java.security.SecureRandom
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.util.encoders.Base64

internal data class Ed25519KeyMaterial(val seed: ByteArray, val publicKey: ByteArray)

internal object Ed25519Ops {
  const val SEED_BYTES = 32
  const val PUBLIC_KEY_BYTES = 32
  const val SIGNATURE_BYTES = 64
  const val FINGERPRINT_CHARS = 32

  fun generate(random: SecureRandom = SecureRandom()): Ed25519KeyMaterial {
    val privateKey = Ed25519PrivateKeyParameters(random)
    val seed = privateKey.encoded
    val publicKey = privateKey.generatePublicKey().encoded
    return Ed25519KeyMaterial(seed, publicKey)
  }

  /** 用固定 seed 重建密钥对（测试向量与恢复路径共用）。 */
  fun fromSeed(seed: ByteArray): Ed25519KeyMaterial {
    require(seed.size == SEED_BYTES) { "Ed25519 seed 必须是 32 字节" }
    val privateKey = Ed25519PrivateKeyParameters(seed, 0)
    return Ed25519KeyMaterial(seed.copyOf(), privateKey.generatePublicKey().encoded)
  }

  fun sign(seed: ByteArray, payload: ByteArray): ByteArray {
    require(seed.size == SEED_BYTES) { "Ed25519 seed 必须是 32 字节" }
    val privateKey = Ed25519PrivateKeyParameters(seed, 0)
    val signer = Ed25519Signer()
    signer.init(true, privateKey)
    signer.update(payload, 0, payload.size)
    return signer.generateSignature()
  }

  fun verify(publicKey: ByteArray, payload: ByteArray, signature: ByteArray): Boolean {
    if (publicKey.size != PUBLIC_KEY_BYTES || signature.size != SIGNATURE_BYTES) return false
    return try {
      val signer = Ed25519Signer()
      signer.init(false, Ed25519PublicKeyParameters(publicKey, 0))
      signer.update(payload, 0, payload.size)
      signer.verifySignature(signature)
    } catch (_: RuntimeException) {
      false
    }
  }

  /** 契约 §1：hex(sha256(rawPubkey))[0..32]，小写。 */
  fun fingerprintHex(publicKey: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(publicKey)
    return digest.joinToString("") { "%02x".format(it) }.take(FINGERPRINT_CHARS)
  }

  /** 标准 base64（含 `=` 填充），与云端 `Buffer.toString('base64')` 一致。 */
  fun base64(bytes: ByteArray): String = Base64.toBase64String(bytes)

  /** 严格解码标准 base64；非法输入返回 null，由调用方 fail-closed。 */
  fun decodeBase64(value: String): ByteArray? {
    if (value.isEmpty()) return null
    return try {
      Base64.decode(value)
    } catch (_: RuntimeException) {
      null
    }
  }
}
