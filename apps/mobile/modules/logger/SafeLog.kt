// SafeLog：Logcat 的唯一日志入口（设计见 docs/architecture/unified-observability-design.md §5.2）。
//
// 规则（与 JS 侧 src/lib/safeLog.ts 同一套脱敏规则，**改一处必须同步另一处**）：
// - 只写「类型/大小/耗时/结果码」类最小化字段；禁业务正文、完整路径、token、
//   剪贴板内容、语音正文、图片；
// - 写前脱敏：单行化 → token/密钥标记与长 hex 脱敏 → 路径脱敏 → 截断；
// - tag 稳定化：模块名 slug（小写、非 [a-z0-9-] 归一为 '-'、限长）。
//
// 本对象不依赖 Android Context：纯 Kotlin 模块（如 Ed25519Ops）也能调用。
package dev.taskdock.modules.logger

import android.util.Log

// public：clipboard / device-identity 等本地模块跨 Gradle 项目调用（implementation
// project(":logger")）；其余成员保持最小可见性。
object SafeLog {
  /** 消息与字符串 metadata 的最大长度：Logcat 单行足够，超限截断。 */
  private const val MAX_TEXT = 512

  /** 日志 tag 最大长度（Android logcat tag 常规上限 23，取保守值）。 */
  private const val MAX_TAG = 23

  fun e(tag: String, message: String) = write("error", tag, message)

  fun w(tag: String, message: String) = write("warn", tag, message)

  fun i(tag: String, message: String) = write("info", tag, message)

  /** 统一入口：LoggerModule 的 write 走这里进 Logcat；文件落盘由 FileLogSink 负责。 */
  fun write(level: String, rawTag: String, message: String) {
    try {
      val tag = normalizeTag(rawTag)
      val text = sanitizeText(message)
      when (level) {
        "error" -> Log.e(tag, text)
        "warn" -> Log.w(tag, text)
        "debug", "trace" -> Log.d(tag, text)
        else -> Log.i(tag, text)
      }
    } catch (_: Throwable) {
      // 日志基础设施绝不抛错、绝不影响业务：Logcat 写失败静默丢弃。
    }
  }

  /** tag 稳定化：小写 slug。空/非法输入退回固定 tag，保证 Logcat 可过滤。 */
  fun normalizeTag(rawTag: String): String {
    val slug = rawTag.lowercase().replace(Regex("[^a-z0-9_-]+"), "-")
      .trim('-')
      .take(MAX_TAG)
    return if (slug.isEmpty()) "app" else slug
  }

  /**
   * 脱敏（与 JS 侧 REDACT 规则一一对应）：
   * - token/password/secret/api_key/authorization/bearer 赋值与 Bearer 前缀 → [redacted]
   * - ≥32 位 hex（设备令牌/密钥形态）与 sk- 前缀密钥 → [redacted]；16 位 traceId 不受影响
   * - Windows 盘符路径、file/content URI、常见 POSIX 系统路径 → [path]
   */
  fun sanitizeText(raw: String): String {
    // Bearer 先于 authorization 标记规则（与 JS 侧同序）：否则
    // "Authorization: Bearer <token>" 的 token 值会被标记规则吃掉前缀后残留。
    var text = raw
      .replace(Regex("[\\r\\n\\t]+"), " ")
      .replace(Regex("(?i)\\bBearer\\s+\\S+"), "[redacted]")
      .replace(Regex("(?i)(?:token|password|secret|api[_-]?key|authorization)\\s*[:=]\\s*\\S+"), "[redacted]")
      .replace(Regex("\\b[0-9a-f]{32,}\\b"), "[redacted]")
      .replace(Regex("\\bsk-[A-Za-z0-9_-]{8,}\\b"), "[redacted]")
      .replace(Regex("[A-Za-z]:\\\\\\S*"), "[path]")
      .replace(Regex("(?i)(?:file|content)://\\S+"), "[path]")
      .replace(Regex("/(?:data|storage|system|proc|home|Users)/\\S*"), "[path]")
    if (text.length > MAX_TEXT) {
      text = text.take(MAX_TEXT) + "…"
    }
    return text
  }
}
