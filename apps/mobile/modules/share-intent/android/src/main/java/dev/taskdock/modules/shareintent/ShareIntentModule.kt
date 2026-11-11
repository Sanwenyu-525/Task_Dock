// 系统分享接收（Android ACTION_SEND text/plain）的原生侧。
//
// 设计要点（与 src/lib/pendingShare.ts 的内存队列配套）：
// 1. 双通道投递：冷启动由 JS 调 takePendingShare() 拉取（此时 JS 监听器尚未挂上，
//    事件会丢，所以必须可拉取）；已运行由 OnNewIntent 发 onShareReceived 事件。
//    两条通道读写同一个待处理槽，先到先得，靠 offerId 在 JS 侧去重。
// 2. 去重：
//    - 待处理槽已有同文本 → 重复投递（同一 Intent 重放/双投递）直接忽略；
//    - OnNewIntent 在 800ms 窗口内重复同一文本 → 判定为系统双投递，忽略第二次
//      （真实用户在 0.8s 内连续分享两条一模一样的文本可以忽略不计）；
//    - 初始 Intent 只在首次 takePendingShare() 时解析一次（进程生命周期内闩住），
//      之后 Activity 因旋转/主题切换重建不会把已消费的分享重新弹出来。
// 3. 截断策略：超过 4000 个 Unicode 码点（与收集箱上限 MAX_CONTENT 一致）按码点
//    截断并标记 truncated，让 UI 明示「已截断」，保存时不会再被 addCapture 拒绝。
// 4. 隐私：本模块不写任何日志；载荷只在内存流转，不落盘、不进剪贴板。
package dev.taskdock.modules.shareintent

import android.content.Intent
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ShareIntentModule : Module() {
  private var pendingText: String? = null
  private var pendingTruncated = false
  private var pendingOriginalLength = 0
  private var offerId = 0

  /** 冷启动 Intent 只检查一次：之后 Activity 重建（配置变化）不重新投递旧分享 */
  private var initialIntentInspected = false

  /** 双投递去重：上一次 onNewIntent 的文本与时刻 */
  private var lastNewIntentText: String? = null
  private var lastNewIntentAtElapsedMs = 0L

  override fun definition() = ModuleDefinition {
    Name(MODULE_NAME)
    Events(EVENT_SHARE_RECEIVED)

    OnNewIntent { intent ->
      offerFromIntent(intent, fromNewIntent = true)
    }

    Function("takePendingShare") {
      takePendingShare()
    }

    Function("clearPendingShare") {
      clearPending()
    }
  }

  /** JS 启动时拉取：首次调用时解析当前 Activity 的启动 Intent（冷启动分享） */
  private fun takePendingShare(): Map<String, Any?>? {
    if (!initialIntentInspected) {
      initialIntentInspected = true
      if (pendingText == null) {
        val intent = appContext.reactContext?.currentActivity?.intent
        if (intent != null) offerFromIntent(intent, fromNewIntent = false)
      }
    }
    val payload = buildPayload(pendingText, pendingTruncated, pendingOriginalLength)
    clearPending()
    return payload
  }

  private fun clearPending() {
    pendingText = null
    pendingTruncated = false
    pendingOriginalLength = 0
  }

  private fun offerFromIntent(intent: Intent?, fromNewIntent: Boolean) {
    val text = extractSharedText(intent) ?: return

    // 同一文本已在待处理槽：重复投递，忽略
    if (pendingText == text) return

    if (fromNewIntent) {
      val now = SystemClock.elapsedRealtime()
      if (text == lastNewIntentText && now - lastNewIntentAtElapsedMs < DOUBLE_DELIVERY_WINDOW_MS) {
        // 同一分享被系统双投递：忽略第二次
        return
      }
      lastNewIntentText = text
      lastNewIntentAtElapsedMs = now
    }

    val originalLength = text.codePointCount(0, text.length)
    var effective = text
    var truncated = false
    if (originalLength > MAX_TEXT_CODE_POINTS) {
      effective = truncateByCodePoints(text, MAX_TEXT_CODE_POINTS)
      truncated = true
    }

    offerId += 1
    pendingText = effective
    pendingTruncated = truncated
    pendingOriginalLength = originalLength

    val payload = buildPayload(effective, truncated, originalLength)
    if (payload != null) {
      sendEvent(EVENT_SHARE_RECEIVED, payload)
    }
  }

  private fun buildPayload(text: String?, truncated: Boolean, originalLength: Int): Map<String, Any?>? {
    val content = text ?: return null
    return mapOf(
      "offerId" to offerId,
      "text" to content,
      "truncated" to truncated,
      "originalLength" to originalLength,
      "receivedAt" to System.currentTimeMillis(),
    )
  }

  /** 只取 text/plain 的 EXTRA_TEXT；图片/文件分享（EXTRA_STREAM）没有文本，返回 null 忽略 */
  private fun extractSharedText(intent: Intent?): String? {
    if (intent == null) return null
    val action = intent.action
    if (action != Intent.ACTION_SEND) return null
    val type = intent.type ?: return null
    if (!type.startsWith("text/")) return null
    // EXTRA_TEXT 可能是 SpannableString 等 CharSequence 实现，统一转 String
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: return null
    return text.trim().ifEmpty { null }
  }

  private fun truncateByCodePoints(text: String, maxCodePoints: Int): String {
    var index = 0
    var count = 0
    while (count < maxCodePoints && index < text.length) {
      val codePoint = Character.codePointAt(text, index)
      index += Character.charCount(codePoint)
      count += 1
    }
    return text.substring(0, index)
  }

  companion object {
    const val MODULE_NAME = "ShareIntent"
    const val EVENT_SHARE_RECEIVED = "onShareReceived"

    /** 与 src/db/captures.ts 的 MAX_CONTENT（桌面端收集箱上限）一致，按 Unicode 码点计 */
    const val MAX_TEXT_CODE_POINTS = 4000

    /** 同文本 onNewIntent 在该窗口内重复到达视为系统双投递 */
    const val DOUBLE_DELIVERY_WINDOW_MS = 800L
  }
}
