// SafeLog：Logcat 的唯一日志入口（设计见 docs/architecture/unified-observability-design.md §5.2）。
//
// 规则（与 JS 侧 src/lib/safeLog.ts 同一套脱敏规则，**改一处必须同步另一处**）：
// - 只写「类型/大小/耗时/结果码」类最小化字段；禁业务正文、完整路径、token、
//   剪贴板内容、语音正文、图片；
// - 写前脱敏：单行化 → 凭据/邮箱/密钥标记与长 hex 脱敏 → 路径脱敏 → 截断；
// - tag 稳定化：模块名 slug（小写、非 [a-z0-9-] 归一为 '-'、限长）。
//
// 本对象不依赖 Android Context：纯 Kotlin 模块（如 Ed25519Ops）也能调用。
package dev.taskdock.modules.logger

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

// public：clipboard / device-identity 等本地模块跨 Gradle 项目调用（implementation
// project(":logger")）；其余成员保持最小可见性。
object SafeLog {
  /** 消息与字符串 metadata 的最大长度：Logcat 单行足够，超限截断。 */
  private const val MAX_TEXT = 512

  /** 日志 tag 最大长度（Android logcat tag 常规上限 23，取保守值）。 */
  private const val MAX_TAG = 23

  // ---- metadata 白名单限额（与 JS 侧 MAX_METADATA_KEYS / MAX_KEY_CHARS /
  // MAX_METADATA_VALUE_CHARS 一致，改一处必须同步另一处）----
  internal const val MAX_METADATA_KEYS = 8
  internal const val MAX_KEY_CHARS = 32
  internal const val MAX_METADATA_VALUE_CHARS = 96

  /**
   * 脱敏规则表（与 JS 侧 REDACT_RULES 一一对应；顺序、标记、替换值必须相同）。
   * 改任何一条正则都要同步 src/lib/safeLog.ts 与双侧规则对照测试。
   *
   * 凭据类 → [redacted]；路径类 → [path]。
   */
  private val RULES: List<Pair<Regex, String>> = listOf(
    // Bearer 先于 authorization 标记规则：否则
    // "Authorization: Bearer <token>" 的 token 值会被标记规则吃掉前缀后残留。
    Regex("\\bBearer\\s+\\S+", RegexOption.IGNORE_CASE) to "[redacted]",
    // 赋值形态：token/password/secret/apiKey/api_key/api-key/apikey/authorization/
    // auth/sig/key 后跟 : 或 =（覆盖 URL 查询参数 ?key= / ?auth= / ?sig= 与
    // header 赋值）。authorization 排在 auth 前，避免前缀被短标记吃掉。
    Regex(
      "\\b(?:authorization|token|password|passwd|secret|api[_-]?key|apikey|auth|sig|key)\\s*[:=]\\s*\\S+",
      RegexOption.IGNORE_CASE,
    ) to "[redacted]",
    // 邮箱地址（不依赖标记前缀，正文里出现即脱敏）。
    Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}") to "[redacted]",
    // ≥32 位 hex（设备令牌/密钥形态）；16 位 traceId 长度不足，不受影响。
    Regex("\\b[0-9a-fA-F]{32,}\\b") to "[redacted]",
    // sk- 前缀密钥形态。
    Regex("\\bsk-[A-Za-z0-9_-]{8,}\\b") to "[redacted]",
    // Windows 盘符路径。
    Regex("[A-Za-z]:\\\\\\S*") to "[path]",
    // file/content URI。
    Regex("(?:file|content)://\\S+", RegexOption.IGNORE_CASE) to "[path]",
    // 常见 POSIX 系统路径。
    Regex("/(?:data|storage|system|proc|home|Users)/\\S*") to "[path]",
  )

  fun e(tag: String, message: String) = write("error", tag, message)

  fun w(tag: String, message: String) = write("warn", tag, message)

  fun i(tag: String, message: String) = write("info", tag, message)

  /** 统一入口：LoggerModule 的 write 走这里进 Logcat；文件落盘由 FileLogSink 负责。 */
  fun write(level: String, rawTag: String, message: String) {
    try {
      writeClean(level, normalizeTag(rawTag), sanitizeText(message))
    } catch (_: Throwable) {
      // 日志基础设施绝不抛错、绝不影响业务：Logcat 写失败静默丢弃。
    }
  }

  /**
   * 已清洗内容直写 Logcat（LoggerModule 用：原生侧先脱敏一次，Logcat 与文件日志
   * 共用同一份脱敏结果，避免二次脱敏或依赖 JS 侧已脱敏的前提）。
   */
  internal fun writeClean(level: String, tag: String, cleanMessage: String) {
    try {
      when (level) {
        "error" -> Log.e(tag, cleanMessage)
        "warn" -> Log.w(tag, cleanMessage)
        "debug", "trace" -> Log.d(tag, cleanMessage)
        else -> Log.i(tag, cleanMessage)
      }
    } catch (_: Throwable) {
      // Logcat 写失败静默丢弃。
    }
  }

  /** tag 稳定化：小写 slug。空/非法输入退回固定 tag，保证 Logcat 可过滤。 */
  fun normalizeTag(rawTag: String): String {
    val slug = rawTag.lowercase().replace(Regex("[^a-z0-9_-]+"), "-")
      .trim('-')
      .take(MAX_TAG)
    return if (slug.isEmpty()) "app" else slug
  }

  /** 文本脱敏（默认 512 字符上限）；规则见 [RULES]，与 JS 侧一一对应。 */
  fun sanitizeText(raw: String): String = sanitizeText(raw, MAX_TEXT)

  /** 文本脱敏 + 截断到 [maxChars]；metadata 字符串值用更短上限复用本方法。 */
  internal fun sanitizeText(raw: String, maxChars: Int): String {
    var text = raw.replace(Regex("[\\r\\n\\t]+"), " ")
    for ((regex, replacement) in RULES) {
      text = regex.replace(text, replacement)
    }
    return if (text.length > maxChars) text.take(maxChars) + "…" else text
  }

  /**
   * metadata JSON 白名单 + 类型/长度限制后重新序列化。
   *
   * - 入参为 null/空白/非法 JSON：返回 null（丢弃 metadata，不丢整条日志）；
   * - 键截断到 [MAX_KEY_CHARS]，撞键后续条目丢弃；键数 ≤ [MAX_METADATA_KEYS]；
   * - 字符串值走 [sanitizeText]（上限 [MAX_METADATA_VALUE_CHARS]）；有限数保留，
   *   NaN/Infinity 归 null；布尔/null 保留；数组/对象/其他类型丢弃；
   * - 全部被丢弃时返回 null。
   */
  fun sanitizeMetadataJson(metadataJson: String?): JSONObject? {
    if (metadataJson.isNullOrBlank()) return null
    val parsed = try {
      JSONObject(metadataJson)
    } catch (_: Throwable) {
      return null
    }
    val out = JSONObject()
    val keys = parsed.keys()
    while (keys.hasNext()) {
      if (out.length() >= MAX_METADATA_KEYS) break
      val rawKey = keys.next()
      val key = rawKey.take(MAX_KEY_CHARS)
      if (out.has(key)) continue
      val sanitized = sanitizeMetadataValue(parsed.opt(rawKey)) ?: continue
      out.put(key, sanitized)
    }
    return if (out.length() == 0) null else out
  }

  private fun sanitizeMetadataValue(raw: Any?): Any? = when (raw) {
    null -> null
    JSONObject.NULL -> null
    is String -> sanitizeText(raw, MAX_METADATA_VALUE_CHARS)
    is Boolean -> raw
    is Number -> {
      val double = raw.toDouble()
      if (double.isFinite()) raw else null
    }
    is JSONObject, is JSONArray -> null
    else -> null
  }
}
