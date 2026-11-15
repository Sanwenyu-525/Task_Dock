package expo.modules.mediastore

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.pdf.PdfDocument
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt
import java.util.UUID

/**
 * 系统相册写入与图片基础处理（本地 Expo 模块）。
 *
 * 安全与边界：
 * - 保存相册只通过 MediaStore（Android 10+ 分区存储 + IS_PENDING 原子可见），
 *   绝不以「文件留在应用缓存」冒充已保存；
 * - 文件名只取末段并替换控制字符/路径分隔符，同名由 MediaStore 或后缀去重；
 * - 所有解码都有采样上限（缩略图按目标尺寸、编辑按 36MP），避免大图 OOM；
 * - 不向 JS 回传绝对路径，只回传 URI；异常信息不含用户文件名以外的敏感数据。
 */
class MediaStoreModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context unavailable" }

  /** PDF 单页保留的最大像素：PdfDocument 按原像素嵌入位图，12MP 会让两页 PDF 达到 40MB。 */
  private val pdfPagePixels = 1_600_000L

  override fun definition() = ModuleDefinition {
    Name("TaskDockMedia")

    AsyncFunction("saveToGalleryAsync") { sourceUri: String, displayName: String, mimeType: String ->
      saveToGallery(sourceUri, displayName, mimeType)
    }

    AsyncFunction("createThumbnailAsync") { sourceUri: String, maxSize: Int ->
      createThumbnail(sourceUri, maxSize)
    }

    AsyncFunction("transformImageAsync") { sourceUri: String, rotate: Int, cropX: Int, cropY: Int, cropWidth: Int, cropHeight: Int, quality: Int ->
      transformImage(sourceUri, rotate, cropX, cropY, cropWidth, cropHeight, quality)
    }

    AsyncFunction("imageInfoAsync") { sourceUri: String ->
      imageInfo(sourceUri)
    }

    // 系统文件选择器只给 content:// URI 时，用 ContentResolver 读取真实显示名与大小；
    // 不在 JS 侧用 URI 末段猜名字（vivo 的末段是 `document:10000692`）。
    AsyncFunction("displayNameAsync") { sourceUri: String ->
      queryDisplayName(sourceUri)
    }

    // 文档扫描：多页图片合成一个 A4 PDF（页序即传入顺序）。
    AsyncFunction("createPdfAsync") { sourceUris: List<String> ->
      createPdf(sourceUris)
    }
  }

  // ── 展示名 / MIME / 大小查询 ───────────────────────────────

  /**
   * 通过 ContentResolver 读取 OpenableColumns 的 DISPLAY_NAME / SIZE。
   * 失败返回空字符串，由调用方决定兜底名；绝不把 `document:123` 当文件名。
   */
  private fun queryDisplayName(sourceUri: String): Map<String, Any> {
    val uri = Uri.parse(sourceUri)
    var name = ""
    var size = 0L
    try {
      context.contentResolver.query(
        uri,
        arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
        null,
        null,
        null,
      )?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex) ?: ""
          val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
        }
      }
    } catch (_: Exception) {
      // 权限/已失效的 URI：退回空值，让 JS 用时间戳兜底名。
    }
    val mime = try {
      context.contentResolver.getType(uri) ?: ""
    } catch (_: Exception) {
      ""
    }
    return mapOf("name" to name, "mime" to mime, "size" to size)
  }

  // ── 相册保存 ───────────────────────────────────────────────

  private fun saveToGallery(sourceUri: String, rawName: String, rawMime: String): Map<String, Any> {
    val name = sanitizeName(rawName)
    val mime = rawMime.ifBlank { guessMime(name) }
    val source = Uri.parse(sourceUri)
    val resolver = context.contentResolver

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val collection: Uri
      val relativePath: String
      when {
        mime.startsWith("image/") -> {
          collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
          relativePath = "${Environment.DIRECTORY_PICTURES}/TaskDock"
        }
        mime.startsWith("video/") -> {
          collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
          relativePath = "${Environment.DIRECTORY_MOVIES}/TaskDock"
        }
        mime.startsWith("audio/") -> {
          collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
          relativePath = "${Environment.DIRECTORY_MUSIC}/TaskDock"
        }
        else -> {
          collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
          relativePath = "${Environment.DIRECTORY_DOWNLOADS}/TaskDock"
        }
      }

      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val target = resolver.insert(collection, values)
        ?: throw IllegalStateException("系统媒体库拒绝创建文件")
      var copied = 0L
      try {
        val input = resolver.openInputStream(source)
          ?: throw IllegalArgumentException("无法读取源文件，请重新采集")
        input.use { sourceStream ->
          val output = resolver.openOutputStream(target, "w")
            ?: throw IllegalStateException("无法写入系统媒体库")
          output.use { targetStream ->
            copied = copyStream(sourceStream, targetStream)
          }
        }
        if (copied <= 0L) throw IllegalStateException("写入系统媒体库失败")
        val publish = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
        resolver.update(target, publish, null, null)
      } catch (error: Exception) {
        try {
          resolver.delete(target, null, null)
        } catch (_: Exception) {
          // 失败补偿：删除半成品；删除失败不覆盖原始错误。
        }
        throw error
      }
      return mapOf(
        "uri" to target.toString(),
        "displayName" to name,
        "size" to copied,
        "mime" to mime,
      )
    }

    // Android 9 及以下：写入公共 Pictures/Downloads 后通知媒体扫描。
    @Suppress("DEPRECATION")
    val base = Environment.getExternalStoragePublicDirectory(
      if (mime.startsWith("image/")) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_DOWNLOADS,
    )
    val directory = File(base, "TaskDock")
    if (!directory.exists() && !directory.mkdirs()) {
      throw IllegalStateException("无法创建相册目录")
    }
    val file = uniqueFile(directory, name)
    var copied = 0L
    val input = resolver.openInputStream(source)
      ?: throw IllegalArgumentException("无法读取源文件，请重新采集")
    input.use { sourceStream ->
      FileOutputStream(file).use { targetStream ->
        copied = copyStream(sourceStream, targetStream)
      }
    }
    if (copied <= 0L) {
      file.delete()
      throw IllegalStateException("写入相册失败")
    }
    MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf(mime), null)
    return mapOf(
      "uri" to Uri.fromFile(file).toString(),
      "displayName" to name,
      "size" to copied,
      "mime" to mime,
    )
  }

  // ── 缩略图 / 旋转裁剪 ─────────────────────────────────────

  private fun createThumbnail(sourceUri: String, maxSizeRaw: Int): Map<String, Any> {
    val maxSize = maxSizeRaw.coerceIn(64, 2048)
    val bounds = decodeBounds(sourceUri)
    val sample = sampleSize(bounds.first, bounds.second, maxSize.toLong() * maxSize.toLong() * 4)
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    val bitmap = openStream(sourceUri).use { BitmapFactory.decodeStream(it, null, options) }
      ?: throw IllegalArgumentException("无法解析图片")
    var scaled: Bitmap? = null
    try {
      val scale = min(1f, maxSize.toFloat() / max(bitmap.width, bitmap.height).toFloat())
      val target = if (scale < 1f) {
        Bitmap.createScaledBitmap(
          bitmap,
          (bitmap.width * scale).roundToInt().coerceAtLeast(1),
          (bitmap.height * scale).roundToInt().coerceAtLeast(1),
          true,
        ).also { scaled = it }
      } else {
        bitmap
      }
      val file = newCacheFile("taskdock-thumbs")
      FileOutputStream(file).use { output ->
        if (!target.compress(Bitmap.CompressFormat.JPEG, 85, output)) {
          throw IllegalStateException("缩略图编码失败")
        }
      }
      return mapOf(
        "uri" to Uri.fromFile(file).toString(),
        "width" to target.width,
        "height" to target.height,
        "mime" to "image/jpeg",
        "size" to file.length(),
      )
    } finally {
      if (scaled != null && scaled !== bitmap) scaled.recycle()
      bitmap.recycle()
    }
  }

  private fun transformImage(
    sourceUri: String,
    rotate: Int,
    cropX: Int,
    cropY: Int,
    cropWidth: Int,
    cropHeight: Int,
    qualityRaw: Int,
  ): Map<String, Any> {
    var working = decodeBounded(sourceUri, 36_000_000L)
    try {
      val normalized = ((rotate % 360) + 360) % 360
      if (normalized != 0) {
        val matrix = Matrix().apply { postRotate(normalized.toFloat()) }
        val rotated = Bitmap.createBitmap(working, 0, 0, working.width, working.height, matrix, true)
        if (rotated !== working) {
          working.recycle()
          working = rotated
        }
      }
      if (cropWidth > 0 && cropHeight > 0 && cropX >= 0 && cropY >= 0) {
        val x = cropX.coerceIn(0, working.width - 1)
        val y = cropY.coerceIn(0, working.height - 1)
        val width = cropWidth.coerceIn(1, working.width - x)
        val height = cropHeight.coerceIn(1, working.height - y)
        if (x != 0 || y != 0 || width != working.width || height != working.height) {
          val cropped = Bitmap.createBitmap(working, x, y, width, height)
          if (cropped !== working) {
            working.recycle()
            working = cropped
          }
        }
      }
      val file = newCacheFile("taskdock-edit")
      val quality = qualityRaw.coerceIn(60, 100)
      FileOutputStream(file).use { output ->
        if (!working.compress(Bitmap.CompressFormat.JPEG, quality, output)) {
          throw IllegalStateException("图片编码失败")
        }
      }
      return mapOf(
        "uri" to Uri.fromFile(file).toString(),
        "width" to working.width,
        "height" to working.height,
        "mime" to "image/jpeg",
        "size" to file.length(),
      )
    } finally {
      if (!working.isRecycled) working.recycle()
    }
  }

  private fun imageInfo(sourceUri: String): Map<String, Any> {
    val (width, height) = decodeBounds(sourceUri)
    val uri = Uri.parse(sourceUri)
    val mime = context.contentResolver.getType(uri) ?: guessMime(uri.lastPathSegment ?: "")
    var size = 0L
    try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val index = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (index >= 0 && !cursor.isNull(index)) size = cursor.getLong(index)
        }
      }
    } catch (_: Exception) {
      // 非 content:// 或查询失败时用文件长度兜底。
    }
    if (size <= 0L && uri.scheme == "file") {
      size = File(requireNotNull(uri.path)).length()
    }
    return mapOf(
      "uri" to sourceUri,
      "width" to width,
      "height" to height,
      "mime" to mime,
      "size" to size,
    )
  }

  // ── 扫描 PDF ──────────────────────────────────────────────

  /** A4 @72dpi 的 PDF 页面尺寸（点）；图片按比例居中填充，四周留 18pt 白边。 */
  private fun createPdf(sourceUris: List<String>): Map<String, Any> {
    if (sourceUris.isEmpty()) throw IllegalArgumentException("没有可导出的扫描页")
    if (sourceUris.size > 200) throw IllegalArgumentException("单次最多导出 200 页")

    val pageWidth = 595
    val pageHeight = 842
    val margin = 18f
    val document = PdfDocument()
    try {
      sourceUris.forEachIndexed { index, uri ->
        // 每页单独解码、单独回收：12MP 上限避免多页同时驻留导致 OOM。
        val decoded = decodeBounded(uri, 12_000_000L)
        val bitmap = downscaleForPdf(decoded)
        try {
          val page = document.startPage(
            PdfDocument.PageInfo.Builder(pageWidth, pageHeight, index + 1).create(),
          )
          try {
            val canvas: Canvas = page.canvas
            canvas.drawColor(Color.WHITE)
            val availableWidth = pageWidth - margin * 2
            val availableHeight = pageHeight - margin * 2
            val scale = min(
              availableWidth / bitmap.width.toFloat(),
              availableHeight / bitmap.height.toFloat(),
            )
            val drawWidth = bitmap.width * scale
            val drawHeight = bitmap.height * scale
            val left = (pageWidth - drawWidth) / 2f
            val top = (pageHeight - drawHeight) / 2f
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
              isFilterBitmap = true
              isDither = true
            }
            canvas.drawBitmap(bitmap, null, RectF(left, top, left + drawWidth, top + drawHeight), paint)
          } finally {
            document.finishPage(page)
          }
        } finally {
          if (!bitmap.isRecycled) bitmap.recycle()
        }
      }

      val directory = File(context.cacheDir, "taskdock-pdf")
      if (!directory.exists() && !directory.mkdirs()) {
        throw IllegalStateException("无法创建临时目录")
      }
      val file = File(directory, "${UUID.randomUUID()}.pdf")
      FileOutputStream(file).use { output -> document.writeTo(output) }
      if (file.length() <= 0L) throw IllegalStateException("PDF 写入失败")
      return mapOf(
        "uri" to Uri.fromFile(file).toString(),
        "size" to file.length(),
        "pages" to sourceUris.size,
        "mime" to "application/pdf",
      )
    } finally {
      document.close()
    }
  }

  // ── 基础工具 ──────────────────────────────────────────────

  /** 扫描页降采样到约 1.6MP（A4 文本仍可读），显著缩小 PDF 体积。 */
  private fun downscaleForPdf(source: Bitmap): Bitmap {
    val pixels = source.width.toLong() * source.height.toLong()
    if (pixels <= pdfPagePixels) return source
    val ratio = sqrt(pdfPagePixels.toDouble() / pixels.toDouble())
    val width = (source.width * ratio).roundToInt().coerceAtLeast(1)
    val height = (source.height * ratio).roundToInt().coerceAtLeast(1)
    val scaled = Bitmap.createScaledBitmap(source, width, height, true)
    if (scaled !== source) source.recycle()
    return scaled
  }

  private fun openStream(uriString: String): InputStream {
    return context.contentResolver.openInputStream(Uri.parse(uriString))
      ?: throw IllegalArgumentException("无法读取源文件，请重新采集")
  }

  private fun decodeBounds(sourceUri: String): Pair<Int, Int> {
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    openStream(sourceUri).use { BitmapFactory.decodeStream(it, null, options) }
    if (options.outWidth <= 0 || options.outHeight <= 0) {
      throw IllegalArgumentException("无法解析图片尺寸")
    }
    return options.outWidth to options.outHeight
  }

  private fun decodeBounded(sourceUri: String, maxPixels: Long): Bitmap {
    val (width, height) = decodeBounds(sourceUri)
    val options = BitmapFactory.Options().apply {
      inSampleSize = sampleSize(width, height, maxPixels)
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    return openStream(sourceUri).use { BitmapFactory.decodeStream(it, null, options) }
      ?: throw IllegalArgumentException("无法解析图片")
  }

  /** 2 的幂采样：保证解码后的像素数不超过 maxPixels。 */
  private fun sampleSize(width: Int, height: Int, maxPixels: Long): Int {
    var sample = 1
    var pixels = width.toLong() * height.toLong()
    while (pixels / 4 > maxPixels && sample < 64) {
      sample *= 2
      pixels /= 4
    }
    return sample
  }

  private fun newCacheFile(subdir: String): File {
    val directory = File(context.cacheDir, subdir)
    if (!directory.exists() && !directory.mkdirs()) {
      throw IllegalStateException("无法创建临时目录")
    }
    return File(directory, "${UUID.randomUUID()}.jpg")
  }

  private fun copyStream(input: InputStream, output: java.io.OutputStream): Long {
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
      val read = input.read(buffer)
      if (read <= 0) break
      output.write(buffer, 0, read)
      total += read
    }
    output.flush()
    return total
  }

  private fun uniqueFile(directory: File, name: String): File {
    val file = File(directory, name)
    if (!file.exists()) return file
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val extension = if (dot > 0) name.substring(dot) else ""
    var index = 1
    while (index < 1000) {
      val candidate = File(directory, "$stem-$index$extension")
      if (!candidate.exists()) return candidate
      index += 1
    }
    return File(directory, "$stem-${System.currentTimeMillis()}$extension")
  }

  private fun sanitizeName(raw: String): String {
    val base = raw.substringAfterLast('/').substringAfterLast('\\')
    val cleaned = base.map { ch ->
      if (ch.isISOControl() || ch in "<>:\"|?*") '_' else ch
    }.joinToString("").trim().trimEnd('.', ' ')
    val fallback = cleaned.ifEmpty { "taskdock-${System.currentTimeMillis()}.jpg" }
    return fallback.take(120)
  }

  private fun guessMime(name: String): String {
    return when (name.substringAfterLast('.', "").lowercase()) {
      "jpg", "jpeg" -> "image/jpeg"
      "png" -> "image/png"
      "webp" -> "image/webp"
      "gif" -> "image/gif"
      "heic", "heif" -> "image/heic"
      "pdf" -> "application/pdf"
      "mp4" -> "video/mp4"
      "m4a" -> "audio/mp4"
      "mp3" -> "audio/mpeg"
      "aac" -> "audio/aac"
      "txt" -> "text/plain"
      else -> "application/octet-stream"
    }
  }
}
