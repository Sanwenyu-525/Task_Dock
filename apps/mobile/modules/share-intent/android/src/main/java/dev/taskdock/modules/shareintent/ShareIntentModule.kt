// 系统分享接收（Android）：ACTION_SEND / ACTION_SEND_MULTIPLE，文本 + 图片 + 音频 + 文件。
//
// 与 src/lib/pendingShare.ts 的契约（v2，向 old 字段兼容）：
// {
//   offerId, text, truncated, originalLength, receivedAt,
//   items:   [{ kind, mime, name, size, path }],   // path = 应用私有目录里的 file:// 绝对路径
//   rejected:[{ name, reason }]                    // 超限/无权限的单项，UI 需要明示
// }
//
// 设计要点：
// 1. 双通道投递：冷启动由 JS 调 takePendingShare() 拉取；已运行由 OnNewIntent 发
//    onShareReceived 事件。两条通道读写同一个待处理槽，先到先得，靠 offerId 去重。
// 2. 字节必须落到应用私有目录再交给 JS：content:// 授权属于发送方进程，分享结束后
//    可能立即失效；不复制就会出现「列表里有条目、点开是坏图」。
// 3. 安全：
//    - 文件名由外部应用提供，绝不用来拼路径；落盘名固定为 item-N + 白名单扩展名；
//    - URI 只通过 ContentResolver 流式读取（64KB 缓冲），不整文件读入内存；
//    - 数量 9、单文件 50MB、合计 200MB 上限，边复制边计数，超限立即中止并删除半成品；
//    - 没有任何日志输出。
// 4. 去重：待处理槽已存在同一签名（action+text+URI 列表）时直接忽略，不重复复制；
//    OnNewIntent 800ms 内的同签名重复投递忽略（系统双投递），见 docs/mobile/09。
// 5. 取消/失败恢复：JS 消费后如果用户放弃保存，由 JS 删除这些文件（它们是私有目录普通
//    文件）；模块自身的 clearPendingShare 只清引用，不删已交付文件。
package dev.taskdock.modules.shareintent

import android.content.ClipData
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream

class ShareIntentModule : Module() {
  private data class PendingItem(
    val kind: String,
    val mime: String,
    val name: String,
    val size: Long,
    val path: String,
  )

  private data class Offer(
    val signature: String,
    val text: String?,
    val truncated: Boolean,
    val originalLength: Int,
    val items: List<PendingItem>,
    val rejected: List<Map<String, String>>,
    val offerId: Int,
  )

  private var pending: Offer? = null
  private var offerSeq = 0
  private var initialIntentInspected = false
  private var lastNewIntentSignature: String? = null
  private var lastNewIntentAtElapsedMs = 0L

  override fun definition() = ModuleDefinition {
    Name(MODULE_NAME)
    Events(EVENT_SHARE_RECEIVED)

    // 冷启动分享：在 Expo 模块创建时就复制，而不是等 JS 调用 takePendingShare。
    // 分享 URI 的临时授权属于接收 Activity；越早复制越不会因 JS 启动慢/Activity 生命周期
    // 变化而遇到 SecurityException（真机曾出现“没有读取该文件的权限”）。
    OnCreate {
      val intent = appContext.currentActivity?.intent
      if (intent != null && (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE)) {
        initialIntentInspected = true
        offerFromIntent(intent, fromNewIntent = false)
      }
    }

    OnNewIntent { intent ->
      offerFromIntent(intent, fromNewIntent = true)?.let { offer ->
        sendEvent(EVENT_SHARE_RECEIVED, buildPayload(offer))
      }
    }

    Function("takePendingShare") {
      takePendingShare()
    }

    Function("clearPendingShare") {
      pending = null
    }

    // 主动分享出去（开发者工具用）：只由用户点「分享」触发一次。
    // 文本不需要 FileProvider；文件通过 FileProvider 生成 content://，
    // 避免 Android 7+ 的 FileUriExposedException。
    AsyncFunction("shareTextAsync") { text: String, subject: String ->
      shareText(text, subject)
      true
    }

    AsyncFunction("shareFileAsync") { fileUri: String, mime: String, subject: String ->
      shareFile(fileUri, mime, subject)
      true
    }
  }

  // ── 主动分享 ──────────────────────────────────────────────

  private fun shareText(text: String, subject: String) {
    if (text.isBlank()) throw IllegalArgumentException("没有可分享的文本")
    val intent = Intent(Intent.ACTION_SEND).apply {
      type = "text/plain"
      putExtra(Intent.EXTRA_TEXT, text)
      if (subject.isNotBlank()) putExtra(Intent.EXTRA_SUBJECT, subject)
    }
    launchChooser(intent, subject)
  }

  private fun shareFile(fileUri: String, mime: String, subject: String) {
    val source = Uri.parse(fileUri)
    val contentUri: Uri = when (source.scheme) {
      "content" -> source
      "file" -> {
        val path = source.path ?: throw IllegalArgumentException("文件路径无效")
        val file = File(path)
        if (!file.exists() || file.length() <= 0L) throw IllegalArgumentException("文件不存在或为空")
        // 只允许分享应用私有目录内的文件：外部路径不进入 FileProvider。
        val canonical = file.canonicalFile
        val roots = listOf(
          requireNotNull(appContext.reactContext).filesDir.canonicalFile,
          requireNotNull(appContext.reactContext).cacheDir.canonicalFile,
        )
        if (roots.none { canonical.path.startsWith(it.path + File.separator) }) {
          throw IllegalArgumentException("只能分享应用目录内的文件")
        }
        val authority = "${requireNotNull(appContext.reactContext).packageName}.toolfiles"
        FileProvider.getUriForFile(requireNotNull(appContext.reactContext), authority, canonical)
      }
      else -> throw IllegalArgumentException("不支持的分享地址：$fileUri")
    }

    val intent = Intent(Intent.ACTION_SEND).apply {
      type = mime.ifBlank { "application/octet-stream" }
      putExtra(Intent.EXTRA_STREAM, contentUri)
      if (subject.isNotBlank()) putExtra(Intent.EXTRA_SUBJECT, subject)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      clipData = ClipData.newUri(requireNotNull(appContext.reactContext).contentResolver, "TaskDock", contentUri)
    }
    launchChooser(intent, subject)
  }

  private fun launchChooser(intent: Intent, subject: String) {
    val title = if (subject.isNotBlank()) "分享：$subject" else "分享"
    val chooser = Intent.createChooser(intent, title)
    val activity = appContext.currentActivity
    if (activity != null) {
      activity.startActivity(chooser)
    } else {
      chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      requireNotNull(appContext.reactContext).startActivity(chooser)
    }
  }

  private fun takePendingShare(): Map<String, Any?>? {
    if (!initialIntentInspected) {
      val intent = if (pending == null) appContext.currentActivity?.intent else null
      if (intent != null) {
        initialIntentInspected = true
        offerFromIntent(intent, fromNewIntent = false)
      } else if (pending != null) {
        initialIntentInspected = true
      }
    }
    val offer = pending ?: return null
    pending = null
    return buildPayload(offer)
  }

  private fun buildPayload(offer: Offer): Map<String, Any?> = mapOf(
    "offerId" to offer.offerId,
    "text" to offer.text,
    "truncated" to offer.truncated,
    "originalLength" to offer.originalLength,
    "receivedAt" to System.currentTimeMillis(),
    "items" to offer.items.map { item ->
      mapOf(
        "kind" to item.kind,
        "mime" to item.mime,
        "name" to item.name,
        "size" to item.size,
        "path" to item.path,
      )
    },
    "rejected" to offer.rejected,
  )

  private fun offerFromIntent(intent: Intent?, fromNewIntent: Boolean): Offer? {
    if (intent == null) return null
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

    val type = intent.type ?: ""
    val text = extractText(intent, type)
    val uris = extractStreamUris(intent)
    if (text == null && uris.isEmpty()) return null

    val signature = "$action|$type|${text ?: ""}|${uris.joinToString(",")}"
    // 同一份内容已在待处理槽：重复投递，忽略（不重复复制文件）
    if (pending?.signature == signature) return null

    if (fromNewIntent) {
      val now = SystemClock.elapsedRealtime()
      if (signature == lastNewIntentSignature && now - lastNewIntentAtElapsedMs < DOUBLE_DELIVERY_WINDOW_MS) {
        return null
      }
      lastNewIntentSignature = signature
      lastNewIntentAtElapsedMs = now
    }

    val originalLength = text?.codePointCount(0, text.length) ?: 0
    var effectiveText = text
    var truncated = false
    if (text != null && originalLength > MAX_TEXT_CODE_POINTS) {
      effectiveText = truncateByCodePoints(text, MAX_TEXT_CODE_POINTS)
      truncated = true
    }

    offerSeq += 1
    val copied = copyStreams(offerSeq, uris, intent.flags)
    val offer = Offer(
      signature = signature,
      text = effectiveText,
      truncated = truncated,
      originalLength = originalLength,
      items = copied.first,
      rejected = copied.second,
      offerId = offerSeq,
    )
    pending = offer
    return offer
  }

  /** 只取 text 类型分享的 EXTRA_TEXT；分享文本时若同时带 STREAM，文本与文件都收下
   *  （Kotlin 块注释可嵌套，注释里不要出现斜杠星号组合，否则会把后续代码吞进注释） */
  private fun extractText(intent: Intent, type: String): String? {
    val raw = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()
    if (!raw.isNullOrEmpty()) {
      // 浏览器分享常把标题/描述也塞进 EXTRA_TEXT，保留原文由用户在采集页编辑
      return raw
    }
    if (!type.startsWith("text/")) return null
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim()
    return subject?.ifEmpty { null }
  }

  @Suppress("DEPRECATION")
  private fun extractStreamUris(intent: Intent): List<Uri> {
    val fromExtra: List<Uri> = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
    } else {
      intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { listOf(it) } ?: emptyList()
    }
    if (fromExtra.isNotEmpty()) return fromExtra
    // 部分分享方只填 ClipData
    return intent.clipData?.let { clip ->
      (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    } ?: emptyList()
  }

  private fun copyStreams(
    offerId: Int,
    uris: List<Uri>,
    grantFlags: Int,
  ): Pair<List<PendingItem>, List<Map<String, String>>> {
    val items = mutableListOf<PendingItem>()
    val rejected = mutableListOf<Map<String, String>>()
    if (uris.isEmpty()) return items to rejected

    val context = appContext.currentActivity ?: appContext.reactContext ?: return items to rejected
    val resolver = context.contentResolver
    val hasReadGrant = (grantFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0
    val dir = File(context.filesDir, "share-intake/offer-$offerId")
    var totalBytes = 0L

    for ((index, uri) in uris.withIndex()) {
      if (items.size >= MAX_ITEMS) {
        rejected.add(mapOf("name" to "第 ${index + 1} 项", "reason" to "一次最多接收 $MAX_ITEMS 项"))
        continue
      }
      val displayName = queryDisplayName(uri) ?: uri.lastPathSegment?.substringAfterLast('/') ?: "文件"
      val declaredSize = querySize(uri)
      if (declaredSize != null && declaredSize > MAX_ITEM_BYTES) {
        rejected.add(mapOf("name" to displayName, "reason" to "超过单文件上限 50MB"))
        continue
      }
      if (totalBytes + (declaredSize ?: 0L) > MAX_TOTAL_BYTES) {
        rejected.add(mapOf("name" to displayName, "reason" to "本次分享合计超过 200MB"))
        continue
      }

      val mime = try {
        resolver.getType(uri)
      } catch (_: SecurityException) {
        null
      } ?: guessMimeFromName(displayName)
      val kind = classify(mime)
      val safeName = safeStorageName(kind, mime, index)
      if (!dir.exists() && !dir.mkdirs()) {
        rejected.add(mapOf("name" to displayName, "reason" to "无法创建接收目录"))
        continue
      }
      val target = File(dir, safeName)
      var copied = 0L
      var tooLarge = false
      try {
        resolver.openInputStream(uri)?.use { input ->
          FileOutputStream(target).use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val read = input.read(buffer)
              if (read <= 0) break
              copied += read
              if (copied > MAX_ITEM_BYTES || totalBytes + copied > MAX_TOTAL_BYTES) {
                tooLarge = true
                break
              }
              output.write(buffer, 0, read)
            }
          }
        } ?: run {
          rejected.add(mapOf("name" to displayName, "reason" to "无法读取分享内容"))
          continue
        }
      } catch (_: SecurityException) {
        target.delete()
        rejected.add(
          mapOf(
            "name" to displayName,
            "reason" to if (hasReadGrant) {
              "没有读取该文件的权限（URI 授权已失效）"
            } else {
              "分享方未授予读取权限（缺少 FLAG_GRANT_READ_URI_PERMISSION），请从系统分享面板重新分享"
            },
          ),
        )
        continue
      } catch (_: java.io.IOException) {
        target.delete()
        rejected.add(mapOf("name" to displayName, "reason" to "复制文件失败"))
        continue
      }

      if (tooLarge) {
        target.delete()
        rejected.add(mapOf("name" to displayName, "reason" to "超过单文件/合计上限"))
        continue
      }
      if (copied <= 0L || !target.exists()) {
        target.delete()
        rejected.add(mapOf("name" to displayName, "reason" to "分享内容为空"))
        continue
      }

      totalBytes += copied
      items.add(
        PendingItem(
          kind = kind,
          mime = mime,
          name = sanitizeDisplayName(displayName, kind),
          size = copied,
          path = target.absolutePath,
        ),
      )
    }
    return items to rejected
  }

  private fun contentResolver(): ContentResolver? =
    appContext.currentActivity?.contentResolver ?: appContext.reactContext?.contentResolver

  private fun queryDisplayName(uri: Uri): String? = try {
    contentResolver()?.query(
      uri,
      arrayOf(OpenableColumns.DISPLAY_NAME),
      null,
      null,
      null,
    )?.use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(0) else null
    }
  } catch (_: RuntimeException) {
    null
  }

  private fun querySize(uri: Uri): Long? = try {
    contentResolver()?.query(
      uri,
      arrayOf(OpenableColumns.SIZE),
      null,
      null,
      null,
    )?.use { cursor ->
      if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
    }
  } catch (_: RuntimeException) {
    null
  }

  private fun classify(mime: String): String = when {
    mime.startsWith("image/") -> "image"
    mime.startsWith("audio/") -> "audio"
    else -> "file"
  }

  /** 落盘名固定 item-N + 白名单扩展名：外部文件名只用于展示，不参与路径拼接 */
  private fun safeStorageName(kind: String, mime: String, index: Int): String {
    val ext = when (mime.lowercase()) {
      "image/jpeg" -> ".jpg"
      "image/png" -> ".png"
      "image/webp" -> ".webp"
      "image/gif" -> ".gif"
      "image/heic", "image/heif" -> ".heic"
      "audio/mpeg" -> ".mp3"
      "audio/mp4", "audio/aac", "audio/m4a" -> ".m4a"
      "audio/wav", "audio/x-wav" -> ".wav"
      "application/pdf" -> ".pdf"
      "text/plain" -> ".txt"
      else -> if (kind == "image") ".img" else if (kind == "audio") ".aac" else ".bin"
    }
    return "item-${index + 1}$ext"
  }

  private fun guessMimeFromName(name: String): String {
    val lower = name.lowercase()
    return when {
      lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
      lower.endsWith(".png") -> "image/png"
      lower.endsWith(".webp") -> "image/webp"
      lower.endsWith(".gif") -> "image/gif"
      lower.endsWith(".heic") -> "image/heic"
      lower.endsWith(".pdf") -> "application/pdf"
      lower.endsWith(".mp3") -> "audio/mpeg"
      lower.endsWith(".m4a") -> "audio/mp4"
      lower.endsWith(".wav") -> "audio/wav"
      lower.endsWith(".txt") -> "text/plain"
      else -> "application/octet-stream"
    }
  }

  /** 展示名清洗：去路径、去控制字符、限长；这个值不回写文件系统路径 */
  private fun sanitizeDisplayName(raw: String, kind: String): String {
    val base = raw.replace('\\', '/').substringAfterLast('/')
    val cleaned = base
      .filterNot { it.code < 0x20 || it.code == 0x7f }
      .replace(Regex("[<>:\"|?*]"), "_")
      .trim()
    val trimmed = if (cleaned.isEmpty()) {
      if (kind == "image") "分享的图片" else if (kind == "audio") "分享的音频" else "分享的文件"
    } else {
      cleaned
    }
    return if (trimmed.length > 80) trimmed.take(80) else trimmed
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

    const val MAX_ITEMS = 9
    const val MAX_ITEM_BYTES = 50L * 1024 * 1024
    const val MAX_TOTAL_BYTES = 200L * 1024 * 1024

    /** 同签名 onNewIntent 在该窗口内重复到达视为系统双投递 */
    const val DOUBLE_DELIVERY_WINDOW_MS = 800L
  }
}
