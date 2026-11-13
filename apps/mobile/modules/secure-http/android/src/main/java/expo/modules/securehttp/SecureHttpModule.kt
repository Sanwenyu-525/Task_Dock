package expo.modules.securehttp

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * 安全 HTTP 通道（手机同步 v2）：强制 HTTPS + 可选 SPKI SHA-256 指纹固定。
 *
 * 安全边界：
 * - 只接受 https:// URL；明文请求直接拒绝（fail-closed，Android 9+ 默认也禁明文）；
 * - pin 非空时：自定义 X509TrustManager 校验
 *   SHA-256(leaf.publicKey.encoded) == pin。`publicKey.encoded` 即证书的
 *   SubjectPublicKeyInfo DER，与桌面端 `mobile_sync::tls` 的指纹是同一份字节；
 *   不依赖系统根证书库（自签证书本就不在系统库里），指纹就是信任锚；
 * - pin 为空（手动输码的首轮配对）：仍是 TLS，但不做指纹比对（首用信任/TOFU），
 *   观察到的指纹经 `lastServerFingerprint` 回传，由 JS 层落库钉住后续连接。
 *   该窗口的中间人风险在 docs/mobile/06-pairing.md §5 记录；
 * - HostnameVerifier：身份已由 SPKI 指纹锚定（或首轮 TOFU），且自签证书只有 CN、
 *   无法覆盖 IP 直连场景，因此不做主机名比对；
 * - 日志纪律：本模块不调用 android.util.Log 输出 URL/证书/指纹/响应内容。
 *
 * 与 JS 层（src/lib/sync/secureFetch.ts）的契约：
 * - AsyncFunction("request"): { url, method, headers, body, timeoutMs, pin, requestId }
 *   → { status: Int, body: String, observedFingerprint: String? }
 * - Function("cancel"): requestId → 取消在途请求（interrupt + 断开底层连接）；
 * - Property("lastServerFingerprint"): 最近一次成功连接观察到的对端 SPKI 指纹。
 */
class SecureHttpModule : Module() {
  private val executor = Executors.newCachedThreadPool { runnable ->
    Thread(runnable).apply {
      isDaemon = true
      name = "secure-http-worker"
    }
  }
  private val requestSeq = AtomicInteger(1)
  private val inFlight = ConcurrentHashMap<Int, InFlight>()
  private val cancelledIds: MutableSet<Int> = Collections.newSetFromMap(ConcurrentHashMap())
  @Volatile
  private var lastFingerprint: String? = null

  private class InFlight(val future: Future<*>, val connection: HttpsURLConnection?)

  override fun definition() = ModuleDefinition {
    Name("SecureHttp")

    Property("lastServerFingerprint") {
      lastFingerprint
    }

    Function("cancel") { requestId: Int ->
      cancelledIds.add(requestId)
      val running = inFlight.remove(requestId) ?: return@Function
      running.future.cancel(true)
      try {
        running.connection?.disconnect()
      } catch (_: Exception) {
        // 取消时连接可能已关闭；不影响取消语义。
      }
    }

    AsyncFunction("request") { options: Map<String, Any?>, promise: Promise ->
      val requestId = (options["requestId"] as? Number)?.toInt() ?: requestSeq.getAndIncrement()
      val url = options["url"] as? String
      val method = (options["method"] as? String)?.uppercase() ?: "GET"
      val headers = options["headers"] as? Map<*, *> ?: emptyMap<Any, Any?>()
      val body = options["body"] as? String
      val timeoutMs = (options["timeoutMs"] as? Number)?.toInt() ?: 30_000
      val pin = (options["pin"] as? String)?.takeIf { it.isNotEmpty() }

      if (url == null || !url.startsWith("https://", ignoreCase = true)) {
        promise.reject("E_INSECURE_URL", "SecureHttp 只接受 https:// 请求", null)
        return@AsyncFunction
      }
      if (cancelledIds.remove(requestId)) {
        promise.reject("E_CANCELLED", "请求已取消", null)
        return@AsyncFunction
      }

      // 先建连接对象（不产生网络 IO），挂进 inFlight 供 cancel 断开；
      // 真正的连接/读写在工作线程里进行。
      val connection = URL(url).openConnection() as HttpsURLConnection
      configure(connection, timeoutMs, pin)
      // 请求方法与头部必须显式落到 connection 上：HttpsURLConnection 默认 GET、
      // 不带自定义头。漏掉时配对 POST 在服务端变成 GET（405 method_not_allowed）、
      // Bearer 鉴权头丢失（401），同步与文件上传全断——2026-11-13 真机 v2 配对实测。
      connection.requestMethod = method
      for ((rawName, rawValue) in headers) {
        val headerName = rawName as? String ?: continue
        val headerValue = rawValue as? String ?: continue
        connection.setRequestProperty(headerName, headerValue)
      }
      val requestBody = body
      if (requestBody != null) {
        connection.doOutput = true
      }

      val future = executor.submit {
        try {
          if (requestBody != null) {
            if (Thread.currentThread().isInterrupted || cancelledIds.contains(requestId)) {
              throw InterruptedException("请求已取消")
            }
            connection.outputStream.use { it.write(requestBody.toByteArray(Charsets.UTF_8)) }
          }
          val result = execute(requestId, connection)
          if (cancelledIds.remove(requestId)) {
            promise.reject("E_CANCELLED", "请求已取消", null)
            return@submit
          }
          promise.resolve(result)
        } catch (error: Exception) {
          val wasCancelled = cancelledIds.remove(requestId) || Thread.currentThread().isInterrupted
          if (wasCancelled) {
            promise.reject("E_CANCELLED", "请求已取消", null)
          } else {
            // 证书/指纹错误常被 HttpsURLConnection 包在 SSLHandshakeException 里：
            // 沿 cause 链判定，否则「指纹不匹配」会被误报成普通网络错误。
            val code = if (isCertificateFailure(error)) "E_PIN_MISMATCH" else "E_NETWORK"
            // 错误消息只含原因摘要，不含 URL 查询参数、证书或指纹原文。
            promise.reject(code, error.message ?: error.javaClass.simpleName, error)
          }
        } finally {
          inFlight.remove(requestId)
          try {
            connection.disconnect()
          } catch (_: Exception) {
          }
        }
      }
      inFlight[requestId] = InFlight(future, connection)
    }
  }

  private fun configure(connection: HttpsURLConnection, timeoutMs: Int, pin: String?) {
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(null, arrayOf<X509TrustManager>(PinnedTrustManager(pin)), SecureRandom())
    connection.sslSocketFactory = sslContext.socketFactory
    // 身份由 SPKI 指纹锚定（见类注释），不做主机名比对。
    connection.hostnameVerifier = HostnameVerifier { _, _ -> true }
    connection.connectTimeout = timeoutMs
    connection.readTimeout = timeoutMs
    connection.instanceFollowRedirects = false
  }

  private fun execute(
    requestId: Int,
    connection: HttpsURLConnection,
  ): Map<String, Any?> {
    if (Thread.currentThread().isInterrupted || cancelledIds.contains(requestId)) {
      throw InterruptedException("请求已取消")
    }
    val status = try {
      connection.responseCode
    } catch (error: IOException) {
      if (Thread.currentThread().isInterrupted || cancelledIds.contains(requestId)) {
        throw InterruptedException("请求已取消")
      }
      throw error
    }
    val stream: InputStream? = if (status in 200..299) connection.inputStream else connection.errorStream
    val responseBody = if (stream != null) readAll(requestId, stream) else ""
    stream?.close()

    val observed = connection.serverCertificates?.firstOrNull() as? X509Certificate
    val observedFingerprint = observed?.let { spkiSha256Hex(it) }
    if (status in 200..299 && observedFingerprint != null) {
      lastFingerprint = observedFingerprint
    }

    return mapOf(
      "status" to status,
      "body" to responseBody,
      "observedFingerprint" to observedFingerprint,
    )
  }

  private fun readAll(requestId: Int, stream: InputStream): String {
    val buffer = ByteArray(16 * 1024)
    val out = ByteArrayOutputStream()
    while (true) {
      if (Thread.currentThread().isInterrupted || cancelledIds.contains(requestId)) {
        throw InterruptedException("请求已取消")
      }
      val read = stream.read(buffer)
      if (read < 0) break
      out.write(buffer, 0, read)
      if (out.size() > MAX_RESPONSE_BYTES) {
        throw IOException("响应体超过上限")
      }
    }
    return out.toString("UTF-8")
  }

  /** 沿 cause 链判定证书类失败（TLS 层常把 CertificateException 再包一层）。 */
  private fun isCertificateFailure(error: Throwable?): Boolean {
    var current = error
    var depth = 0
    while (current != null && depth < MAX_CAUSE_DEPTH) {
      if (current is CertificateException) return true
      current = current.cause
      depth += 1
    }
    return false
  }

  private fun spkiSha256Hex(certificate: X509Certificate): String {
    // publicKey.encoded = X.509 SubjectPublicKeyInfo DER；与桌面端指纹同一输入。
    val digest = MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded)
    return digest.joinToString("") { "%02x".format(it) }
  }

  private companion object {
    /** 同步协议单包上限 1MB + 文件分块信封 ~512KB，取 4MB 防御性上限。 */
    const val MAX_RESPONSE_BYTES = 4 * 1024 * 1024
    /** cause 链深度上限：防御病态异常链导致的无界遍历。 */
    const val MAX_CAUSE_DEPTH = 8
  }
}

/**
 * SPKI 固定 TrustManager。
 *
 * - pin 非空：校验叶子证书 SPKI SHA-256 == pin（小写比较），同时校验未过期；
 * - pin 为空：首用信任（TOFU），只校验未过期；指纹由调用方记录。
 *
 * 有意不委托系统 TrustManager：自签证书无法通过系统链验证，
 * 指纹比对本身就是完整的服务端身份校验。
 */
private class PinnedTrustManager(private val pin: String?) : X509TrustManager {
  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
    throw CertificateException("SecureHttp 不使用客户端证书")
  }

  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
    val leaf = chain.firstOrNull() ?: throw CertificateException("服务器证书链为空")
    leaf.checkValidity()
    if (pin == null) return
    val digest = MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded)
    val hex = digest.joinToString("") { "%02x".format(it) }
    if (hex != pin.lowercase()) {
      throw CertificateException("桌面端证书指纹不匹配（可能存在中间人），已拒绝连接")
    }
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
