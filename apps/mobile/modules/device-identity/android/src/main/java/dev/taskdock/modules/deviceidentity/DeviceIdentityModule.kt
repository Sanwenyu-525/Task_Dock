// Personal Hub 设备身份（Android）：唯一接触 Ed25519 私钥 seed 的边界。
//
// 暴露给 JS 的 API（契约 §6，绝不返回 seed/私钥）：
// - ensureIdentity(): { deviceId, publicKeyBase64, fingerprint }
// - getIdentity(): 同上或 null
// - sign(payloadBase64): base64(64B Ed25519 signature)
// - getProtectionLevel(): 'strongbox' | 'tee' | 'software'
// - deleteIdentity(): 撤销/重置（显式调用）
//
// 线程模型：所有 Keystore/文件/签名操作串行执行在单线程执行器上，避免并发解密与
// 半写文件；Promise 在成功后 resolve、失败按稳定 code reject。
// 日志纪律：不打印 payload、seed、公钥正文或签名。
package dev.taskdock.modules.deviceidentity

import java.util.concurrent.Executors
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DeviceIdentityModule : Module() {
  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable).apply {
      isDaemon = true
      name = "device-identity"
    }
  }

  private fun store(): IdentityStore {
    val context = appContext.reactContext
      ?: throw IdentityStorageException("Android 上下文不可用")
    return IdentityStore(context)
  }

  private fun identityMap(identity: DeviceIdentityPublic): Map<String, Any?> = mapOf(
    "deviceId" to identity.deviceId,
    "publicKeyBase64" to identity.publicKeyBase64,
    "fingerprint" to identity.fingerprint,
  )

  private fun run(
    promise: Promise,
    errorCode: String,
    block: () -> Any?,
  ) {
    executor.execute {
      try {
        promise.resolve(block())
      } catch (error: IdentityStorageException) {
        promise.reject(errorCode, error.message ?: "设备身份操作失败", error)
      } catch (error: Exception) {
        // 不把底层异常文本直接抛给 JS：可能含文件路径；只保留稳定 code。
        promise.reject(errorCode, "设备身份操作失败", error)
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("DeviceIdentity")

    AsyncFunction("ensureIdentity") { promise: Promise ->
      run(promise, "E_IDENTITY_UNAVAILABLE") {
        identityMap(store().ensureIdentity())
      }
    }

    AsyncFunction("getIdentity") { promise: Promise ->
      run(promise, "E_IDENTITY_UNAVAILABLE") {
        store().getIdentity()?.let { identityMap(it) }
      }
    }

    AsyncFunction("sign") { payloadBase64: String, promise: Promise ->
      run(promise, "E_SIGN_FAILED") {
        val payload = Ed25519Ops.decodeBase64(payloadBase64)
          ?: throw IdentityStorageException("签名载荷不是合法 base64")
        if (payload.size > MAX_SIGN_BYTES) {
          throw IdentityStorageException("签名载荷超过上限")
        }
        Ed25519Ops.base64(store().sign(payload))
      }
    }

    AsyncFunction("getProtectionLevel") { promise: Promise ->
      run(promise, "E_KEYSTORE_UNAVAILABLE") {
        store().protectionLevel()
      }
    }

    AsyncFunction("deleteIdentity") { promise: Promise ->
      run(promise, "E_IDENTITY_DELETE_FAILED") {
        store().deleteIdentity()
        null
      }
    }

    OnDestroy {
      executor.shutdownNow()
    }
  }

  private companion object {
    /** 设备签名载荷是小型 canonical JSON；1MB 足够且能防御异常调用。 */
    const val MAX_SIGN_BYTES = 1024 * 1024
  }
}
