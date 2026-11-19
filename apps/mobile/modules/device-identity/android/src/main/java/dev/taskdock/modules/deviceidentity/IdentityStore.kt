// 设备身份的本地持久化：Ed25519 私钥 seed 只以 Keystore AES-GCM 密文形式落盘。
//
// 落盘位置：`context.noBackupFilesDir/hub/identity-v1.json`
// - noBackupFilesDir 不参与 Auto Backup / 云备份 / adb backup，避免私钥密文被带出设备；
// - 文件本身是应用私有目录，其他应用不可读；
// - 记录里只有密文、IV、公钥、指纹与设备 ID；**没有**明文 seed、令牌或系统凭据。
//
// 失败关闭：
// - 文件存在但解析/校验失败时抛错，不静默重建身份（重建会让已配对设备永久失联，
//   且掩盖存储损坏）；用户必须显式 deleteIdentity() 后重新配对；
// - 签名前从 seed 重新推导公钥并与记录比对，密文被替换/截断一律拒绝。
package dev.taskdock.modules.deviceidentity

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.util.Arrays
import java.util.UUID
import org.json.JSONObject

internal data class DeviceIdentityPublic(
  val deviceId: String,
  val publicKeyBase64: String,
  val fingerprint: String,
)

internal class IdentityStore(context: Context) {
  private val lock = Any()
  private val keystore = KeystoreAes(context)
  private val directory = File(context.noBackupFilesDir, DIR_NAME)
  private val identityFile = File(directory, FILE_NAME)

  fun ensureIdentity(): DeviceIdentityPublic = synchronized(lock) {
    val existing = readRecord()
    if (existing != null) return existing.toPublic()

    val keyMaterial = Ed25519Ops.generate()
    try {
      val wrapped = keystore.encrypt(keyMaterial.seed)
      val record = IdentityRecord(
        version = RECORD_VERSION,
        deviceId = UUID.randomUUID().toString(),
        publicKeyBase64 = Ed25519Ops.base64(keyMaterial.publicKey),
        fingerprint = Ed25519Ops.fingerprintHex(keyMaterial.publicKey),
        ciphertext = Ed25519Ops.base64(wrapped.ciphertext),
        iv = Ed25519Ops.base64(wrapped.iv),
        protectionLevel = wrapped.protectionLevel,
        createdAt = System.currentTimeMillis(),
      )
      writeRecord(record)
      record.toPublic()
    } finally {
      // 无论加密/落盘是否成功，进程内的 seed 副本都必须清零。
      Arrays.fill(keyMaterial.seed, 0)
    }
  }

  fun getIdentity(): DeviceIdentityPublic? = synchronized(lock) {
    readRecord()?.toPublic()
  }

  /** 返回 64 字节 Ed25519 签名；seed 只在本次调用的栈上短暂存在。 */
  fun sign(payload: ByteArray): ByteArray = synchronized(lock) {
    val record = readRecord()
      ?: throw IdentityStorageException("本机尚未生成 Personal Hub 设备身份")
    val ciphertext = Ed25519Ops.decodeBase64(record.ciphertext)
      ?: throw IdentityStorageException("身份密文不是合法 base64")
    val iv = Ed25519Ops.decodeBase64(record.iv)
      ?: throw IdentityStorageException("身份密文 IV 不是合法 base64")

    val seed = keystore.decrypt(ciphertext, iv)
    try {
      if (seed.size != Ed25519Ops.SEED_BYTES) {
        throw IdentityStorageException("身份 seed 长度非法")
      }
      val derivedPublic = Ed25519Ops.fromSeed(seed).publicKey
      val expectedPublic = Ed25519Ops.decodeBase64(record.publicKeyBase64)
      if (expectedPublic == null || !derivedPublic.contentEquals(expectedPublic)) {
        throw IdentityStorageException("身份密钥与公钥不匹配，已拒绝签名")
      }
      Ed25519Ops.sign(seed, payload)
    } finally {
      Arrays.fill(seed, 0)
    }
  }

  fun protectionLevel(): String = synchronized(lock) {
    readRecord()?.protectionLevel ?: keystore.currentProtectionLevel()
  }

  /** 撤销/重置：先删身份文件，再删 Keystore 包装密钥，旧密文随即不可解。 */
  fun deleteIdentity() = synchronized(lock) {
    if (identityFile.exists() && !identityFile.delete()) {
      throw IdentityStorageException("无法删除本机身份文件")
    }
    keystore.deleteKey()
  }

  private fun readRecord(): IdentityRecord? {
    if (!identityFile.exists()) return null
    val text = try {
      identityFile.readText(Charsets.UTF_8)
    } catch (error: Exception) {
      throw IdentityStorageException("无法读取本机身份文件", error)
    }
    val json = try {
      JSONObject(text)
    } catch (error: Exception) {
      throw IdentityStorageException("本机身份文件已损坏", error)
    }
    if (json.optInt("version", -1) != RECORD_VERSION) {
      throw IdentityStorageException("本机身份文件版本不受支持")
    }
    val record = IdentityRecord(
      version = RECORD_VERSION,
      deviceId = json.optString("deviceId", ""),
      publicKeyBase64 = json.optString("publicKeyBase64", ""),
      fingerprint = json.optString("fingerprint", ""),
      ciphertext = json.optString("ciphertext", ""),
      iv = json.optString("iv", ""),
      protectionLevel = json.optString("protectionLevel", "software"),
      createdAt = json.optLong("createdAt", 0L),
    )
    if (
      record.deviceId.isEmpty() ||
      record.publicKeyBase64.isEmpty() ||
      record.fingerprint.isEmpty() ||
      record.ciphertext.isEmpty() ||
      record.iv.isEmpty()
    ) {
      throw IdentityStorageException("本机身份文件字段不完整")
    }
    val publicKey = Ed25519Ops.decodeBase64(record.publicKeyBase64)
      ?: throw IdentityStorageException("身份公钥不是合法 base64")
    if (publicKey.size != Ed25519Ops.PUBLIC_KEY_BYTES) {
      throw IdentityStorageException("身份公钥长度非法")
    }
    if (Ed25519Ops.fingerprintHex(publicKey) != record.fingerprint) {
      throw IdentityStorageException("身份指纹与公钥不一致")
    }
    return record
  }

  /** 先写临时文件并 fsync，再原子替换；失败时不留下半截 JSON。 */
  private fun writeRecord(record: IdentityRecord) {
    val json = JSONObject()
      .put("version", record.version)
      .put("deviceId", record.deviceId)
      .put("publicKeyBase64", record.publicKeyBase64)
      .put("fingerprint", record.fingerprint)
      .put("ciphertext", record.ciphertext)
      .put("iv", record.iv)
      .put("protectionLevel", record.protectionLevel)
      .put("createdAt", record.createdAt)

    try {
      if (!directory.exists() && !directory.mkdirs()) {
        throw IdentityStorageException("无法创建身份存储目录")
      }
      val temp = File(directory, "$FILE_NAME.tmp")
      FileOutputStream(temp).use { stream ->
        stream.write(json.toString().toByteArray(Charsets.UTF_8))
        stream.flush()
        stream.fd.sync()
      }
      if (identityFile.exists() && !identityFile.delete()) {
        temp.delete()
        throw IdentityStorageException("无法替换旧身份文件")
      }
      if (!temp.renameTo(identityFile)) {
        temp.delete()
        throw IdentityStorageException("无法写入身份文件")
      }
    } catch (error: IdentityStorageException) {
      throw error
    } catch (error: Exception) {
      throw IdentityStorageException("身份文件写入失败", error)
    }
  }

  private data class IdentityRecord(
    val version: Int,
    val deviceId: String,
    val publicKeyBase64: String,
    val fingerprint: String,
    val ciphertext: String,
    val iv: String,
    val protectionLevel: String,
    val createdAt: Long,
  ) {
    fun toPublic() = DeviceIdentityPublic(deviceId, publicKeyBase64, fingerprint)
  }

  private companion object {
    const val DIR_NAME = "hub"
    const val FILE_NAME = "identity-v1.json"
    const val RECORD_VERSION = 1
  }
}
