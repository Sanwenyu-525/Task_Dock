// AndroidKeyStore 信封加密：AES-256-GCM 包装 Ed25519 seed（契约 §6 已裁定方案）。
//
// 设计要点：
// - 密钥生成在 Keystore 内，setRandomizedEncryptionRequired(true)，不设置用户认证要求
//   （本阶段不做 BiometricPrompt；P5 才引入本机认证，二者不能混淆）；
// - 优先 StrongBox（API 28+ 且设备声明 FEATURE_STRONGBOX_KEYSTORE），不可用则退化为
//   普通 Keystore 密钥；退化不是「关闭加密」，seed 仍由 Keystore 密钥保护；
// - 保护等级必须如实返回：API 31+ 读 KeyInfo.securityLevel；更早版本无法区分 TEE/软件，
//   保守返回 "software"，不冒称硬件保护；
// - 本类不持有 seed 的长期副本：加密后由调用方清零，解密结果由签名方用后清零。
package dev.taskdock.modules.deviceidentity

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.annotation.RequiresApi
import java.security.KeyFactory
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class WrappedSeed(val ciphertext: ByteArray, val iv: ByteArray, val protectionLevel: String)

internal class IdentityStorageException(message: String, cause: Throwable? = null) :
  Exception(message, cause)

internal class KeystoreAes(private val context: Context) {
  private val lock = Any()

  /** 确保包装密钥存在并返回真实保护等级。 */
  fun ensureKey(): String = synchronized(lock) {
    val keyStore = loadKeyStore()
    if (keyStore.containsAlias(KEY_ALIAS)) {
      return protectionLevelOf(keyStore)
    }
    val strongBoxKey = tryGenerateStrongBox()
    if (strongBoxKey != null) {
      // API 28–30 没有 KeyInfo.securityLevel；请求 StrongBox 成功即可确认。
      return "strongbox"
    }
    generateStandardKey()
    return protectionLevelOf(loadKeyStore())
  }

  /** 只查询，不创建：用于 JS 的 getProtectionLevel()。无密钥时按软件等级上报。 */
  fun currentProtectionLevel(): String = synchronized(lock) {
    val keyStore = loadKeyStore()
    if (!keyStore.containsAlias(KEY_ALIAS)) return "software"
    protectionLevelOf(keyStore)
  }

  fun encrypt(plaintext: ByteArray): WrappedSeed = synchronized(lock) {
    val level = ensureKey()
    val key = loadKeyStore().getKey(KEY_ALIAS, null) as? SecretKey
      ?: throw IdentityStorageException("Keystore 包装密钥不可用")
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key)
    val ciphertext = cipher.doFinal(plaintext)
    WrappedSeed(ciphertext, cipher.iv, level)
  }

  fun decrypt(ciphertext: ByteArray, iv: ByteArray): ByteArray = synchronized(lock) {
    val key = loadKeyStore().getKey(KEY_ALIAS, null) as? SecretKey
      ?: throw IdentityStorageException("Keystore 包装密钥不可用")
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
    cipher.doFinal(ciphertext)
  }

  fun deleteKey() = synchronized(lock) {
    val keyStore = loadKeyStore()
    if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS)
  }

  private fun loadKeyStore(): KeyStore =
    KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  private fun generateStandardKey() {
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(buildSpec(strongBox = false))
    generator.generateKey()
  }

  /**
   * StrongBox 是可选硬件能力：仅在设备声明且本次请求成功时使用。
   * 失败（含厂商实现抛出的 ProviderException 包装）必须回退到普通 Keystore 密钥，
   * 否则一台没有 StrongBox 的手机将完全无法生成身份。
   */
  private fun tryGenerateStrongBox(): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)) {
      return null
    }
    return try {
      generateStrongBoxKey()
      "strongbox"
    } catch (_: StrongBoxUnavailableException) {
      null
    } catch (_: Exception) {
      null
    }
  }

  @RequiresApi(Build.VERSION_CODES.P)
  private fun generateStrongBoxKey() {
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(buildSpec(strongBox = true))
    generator.generateKey()
  }

  private fun buildSpec(strongBox: Boolean): KeyGenParameterSpec {
    val builder = KeyGenParameterSpec.Builder(
      KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(KEY_BITS)
      .setUserAuthenticationRequired(false)
      .setRandomizedEncryptionRequired(true)
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setIsStrongBoxBacked(true)
    }
    return builder.build()
  }

  private fun protectionLevelOf(keyStore: KeyStore): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      // API 24–30 没有公开 API 证明 TEE/StrongBox；不冒称硬件保护。
      return "software"
    }
    return try {
      val key = keyStore.getKey(KEY_ALIAS, null) ?: return "software"
      val factory = KeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE)
      val info = factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo
      when (info.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
        // 2 = SECURITY_LEVEL_HARDWARE（部分厂商/旧实现返回的硬件等级）。
        2 -> "tee"
        KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
        else -> "software"
      }
    } catch (_: Exception) {
      "software"
    }
  }

  private companion object {
    const val ANDROID_KEYSTORE = "AndroidKeyStore"
    const val KEY_ALIAS = "taskdock.hub.identity.wrap.v1"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val KEY_BITS = 256
    const val GCM_TAG_BITS = 128
  }
}
