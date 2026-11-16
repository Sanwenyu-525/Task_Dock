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
import android.media.ExifInterface
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
import java.util.Collections
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

    // 开发者工具：真正重编码压缩（不是改扩展名）。输出路径由 JS 传入，
    // 原生侧再次校验必须落在应用 files/cache 目录内，防止不可信路径覆盖其他文件。
    AsyncFunction("compressImageAsync") { sourceUri: String, outputPath: String, maxWidth: Int, maxHeight: Int, quality: Int, format: String ->
      compressImage(sourceUri, outputPath, maxWidth, maxHeight, quality, format)
    }

    // 取色会话：解码一次、按需采样像素。只保留最多 2 个会话，
    // 避免大图在原生堆里长期驻留；关闭页面必须调用 closeImageSessionAsync。
    AsyncFunction("openImageSessionAsync") { sourceUri: String, maxDimension: Int ->
      openImageSession(sourceUri, maxDimension)
    }

    AsyncFunction("samplePixelsAsync") { sessionId: String, xs: List<Int>, ys: List<Int> ->
      samplePixels(sessionId, xs, ys)
    }

    AsyncFunction("closeImageSessionAsync") { sessionId: String ->
      closeImageSession(sessionId)
    }

    OnDestroy {
      closeAllSessions()
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

  // ── 开发者工具：压缩 / 取色 ─────────────────────────────

  /** 取色会话：一张解码后的位图 + 展示尺寸。坐标为「屏幕方向」像素坐标（已应用 EXIF 旋转）。 */
  private data class ImageSession(val bitmap: Bitmap, val width: Int, val height: Int)

  /** 最多保留 2 个会话，超出按插入顺序回收最旧的一张，避免多张大图同时驻留。 */
  private val sessions: MutableMap<String, ImageSession> =
    Collections.synchronizedMap(LinkedHashMap<String, ImageSession>())

  /**
   * 真正重新编码：解码 → EXIF 方向纠正 → 按最大宽高缩放 → 编码写盘。
   *
   * 关键事实：
   * - 输出字节是重新编码产生的，不是改扩展名；
   * - 因为重新编码，EXIF（含 GPS 位置）默认被移除（Bitmap.compress 不写 EXIF）；
   * - JPEG 不支持透明通道，带透明像素时合成到白底，避免出现黑块；
   * - 内存上限：解码时按目标像素的 4 倍采样，最大图也不会整张全分辨率解码。
   */
  @Suppress("DEPRECATION")
  private fun compressImage(
    sourceUri: String,
    outputPath: String,
    maxWidthRaw: Int,
    maxHeightRaw: Int,
    qualityRaw: Int,
    formatRaw: String,
  ): Map<String, Any> {
    val targetFile = resolveOutputFile(outputPath)
    val format = formatRaw.lowercase()
    val compressFormat: Bitmap.CompressFormat = when (format) {
      "jpeg" -> Bitmap.CompressFormat.JPEG
      "png" -> Bitmap.CompressFormat.PNG
      "webp" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Bitmap.CompressFormat.WEBP_LOSSY
      } else {
        Bitmap.CompressFormat.WEBP
      }
      else -> throw IllegalArgumentException("不支持的输出格式：$formatRaw")
    }
    val quality = qualityRaw.coerceIn(10, 100)
    val (rawWidth, rawHeight) = decodeBounds(sourceUri)
    val orientation = readOrientation(sourceUri)
    val swap = orientation == ExifInterface.ORIENTATION_ROTATE_90 ||
      orientation == ExifInterface.ORIENTATION_ROTATE_270 ||
      orientation == ExifInterface.ORIENTATION_TRANSPOSE ||
      orientation == ExifInterface.ORIENTATION_TRANSVERSE
    val orientedWidth = if (swap) rawHeight else rawWidth
    val orientedHeight = if (swap) rawWidth else rawHeight

    val maxWidth = if (maxWidthRaw > 0) maxWidthRaw else orientedWidth
    val maxHeight = if (maxHeightRaw > 0) maxHeightRaw else orientedHeight
    val scale = min(
      1f,
      min(maxWidth.toFloat() / orientedWidth, maxHeight.toFloat() / orientedHeight),
    )
    val targetWidth = (orientedWidth * scale).roundToInt().coerceIn(1, orientedWidth)
    val targetHeight = (orientedHeight * scale).roundToInt().coerceIn(1, orientedHeight)

    // 采样上限 = 目标像素 4 倍 + 1MP：给旋转/缩放留余量，同时挡住 48MP 全解码。
    val decodeBudget = targetWidth.toLong() * targetHeight.toLong() * 4 + 1_000_000L
    val options = BitmapFactory.Options().apply {
      inSampleSize = sampleSize(rawWidth, rawHeight, decodeBudget)
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    var working = openStream(sourceUri).use { BitmapFactory.decodeStream(it, null, options) }
      ?: throw IllegalArgumentException("无法解析图片，可能是损坏文件或不受支持的编码")

    try {
      // 1) 方向纠正（旋转/镜像）——必须在缩放前做，否则宽高比会被算错。
      val matrix = orientationMatrix(orientation)
      if (!matrix.isIdentity) {
        val rotated = Bitmap.createBitmap(working, 0, 0, working.width, working.height, matrix, true)
        if (rotated !== working) {
          working.recycle()
          working = rotated
        }
      }
      // 2) 精确缩放到目标尺寸
      if (working.width != targetWidth || working.height != targetHeight) {
        val scaled = Bitmap.createScaledBitmap(working, targetWidth, targetHeight, true)
        if (scaled !== working) {
          working.recycle()
          working = scaled
        }
      }
      // 3) JPEG 无 alpha：透明像素合成到白底，避免相册里出现黑块
      var flattened: Bitmap? = null
      if (compressFormat == Bitmap.CompressFormat.JPEG && working.hasAlpha()) {
        val canvasBitmap = Bitmap.createBitmap(working.width, working.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(canvasBitmap)
        canvas.drawColor(Color.WHITE)
        canvas.drawBitmap(working, 0f, 0f, Paint(Paint.ANTI_ALIAS_FLAG))
        flattened = canvasBitmap
      }
      val outputBitmap = flattened ?: working

      try {
        targetFile.parentFile?.mkdirs()
        val temp = File(targetFile.parentFile, "${targetFile.name}.part")
        try {
          FileOutputStream(temp).use { stream ->
            if (!outputBitmap.compress(compressFormat, quality, stream)) {
              throw IllegalStateException("图片编码失败")
            }
          }
          if (temp.length() <= 0L) throw IllegalStateException("压缩结果为空文件")
          if (targetFile.exists() && !targetFile.delete()) {
            throw IllegalStateException("无法覆盖已有输出文件")
          }
          if (!temp.renameTo(targetFile)) {
            throw IllegalStateException("无法保存压缩结果")
          }
        } finally {
          if (temp.exists()) temp.delete()
        }
      } finally {
        if (flattened != null && !flattened.isRecycled) flattened.recycle()
      }

      return mapOf(
        "uri" to Uri.fromFile(targetFile).toString(),
        "path" to targetFile.absolutePath,
        "width" to targetWidth,
        "height" to targetHeight,
        "sourceWidth" to rawWidth,
        "sourceHeight" to rawHeight,
        "orientation" to orientation,
        "mime" to mimeOf(format),
        "size" to targetFile.length(),
        "format" to format,
      )
    } finally {
      if (!working.isRecycled) working.recycle()
    }
  }

  private fun openImageSession(sourceUri: String, maxDimensionRaw: Int): Map<String, Any> {
    val maxDimension = maxDimensionRaw.coerceIn(256, 2048)
    val (rawWidth, rawHeight) = decodeBounds(sourceUri)
    val orientation = readOrientation(sourceUri)
    val budget = maxDimension.toLong() * maxDimension.toLong() * 2
    val options = BitmapFactory.Options().apply {
      inSampleSize = sampleSize(rawWidth, rawHeight, budget)
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    var bitmap = openStream(sourceUri).use { BitmapFactory.decodeStream(it, null, options) }
      ?: throw IllegalArgumentException("无法解析图片")
    try {
      val matrix = orientationMatrix(orientation)
      if (!matrix.isIdentity) {
        val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        if (rotated !== bitmap) {
          bitmap.recycle()
          bitmap = rotated
        }
      }
      val longest = max(bitmap.width, bitmap.height)
      if (longest > maxDimension) {
        val scale = maxDimension.toFloat() / longest
        val scaled = Bitmap.createScaledBitmap(
          bitmap,
          (bitmap.width * scale).roundToInt().coerceAtLeast(1),
          (bitmap.height * scale).roundToInt().coerceAtLeast(1),
          true,
        )
        if (scaled !== bitmap) {
          bitmap.recycle()
          bitmap = scaled
        }
      }
    } catch (error: Exception) {
      if (!bitmap.isRecycled) bitmap.recycle()
      throw error
    }

    val id = UUID.randomUUID().toString()
    synchronized(sessions) {
      while (sessions.size >= 2) {
        val oldest = sessions.keys.firstOrNull() ?: break
        sessions.remove(oldest)?.bitmap?.recycle()
      }
      sessions[id] = ImageSession(bitmap, bitmap.width, bitmap.height)
    }
    return mapOf("id" to id, "width" to bitmap.width, "height" to bitmap.height)
  }

  /**
   * 批量采样：一次调用返回多个点的 ARGB。越界返回 -1，绝不生成「触摸位置模拟色」。
   * ARGB 用 Long 返回，避免 Int 在 JS 里变成负数。
   */
  private fun samplePixels(sessionId: String, xs: List<Int>, ys: List<Int>): List<Long> {
    if (xs.size != ys.size) throw IllegalArgumentException("xs 与 ys 数量不一致")
    if (xs.size > 4096) throw IllegalArgumentException("单次最多采样 4096 个点")
    val session = synchronized(sessions) { sessions[sessionId] }
      ?: throw IllegalArgumentException("取色会话已关闭，请重新选择图片")
    return xs.indices.map { index ->
      val x = xs[index]
      val y = ys[index]
      if (x < 0 || y < 0 || x >= session.width || y >= session.height) {
        -1L
      } else {
        session.bitmap.getPixel(x, y).toLong() and 0xFFFFFFFFL
      }
    }
  }

  private fun closeImageSession(sessionId: String) {
    val removed = synchronized(sessions) { sessions.remove(sessionId) }
    removed?.bitmap?.let { if (!it.isRecycled) it.recycle() }
  }

  private fun closeAllSessions() {
    synchronized(sessions) {
      sessions.values.forEach { session -> if (!session.bitmap.isRecycled) session.bitmap.recycle() }
      sessions.clear()
    }
  }

  /** EXIF 方向：只读取流，不落盘、不回传。失败按「正常方向」处理。 */
  private fun readOrientation(sourceUri: String): Int {
    return try {
      openStream(sourceUri).use { stream ->
        ExifInterface(stream).getAttributeInt(
          ExifInterface.TAG_ORIENTATION,
          ExifInterface.ORIENTATION_NORMAL,
        )
      }
    } catch (_: Exception) {
      ExifInterface.ORIENTATION_NORMAL
    }
  }

  private fun orientationMatrix(orientation: Int): Matrix {
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> {
        matrix.setRotate(90f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> {
        matrix.setRotate(270f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
      else -> matrix.setRotate(0f)
    }
    return matrix
  }

  /**
   * 输出路径校验：必须是应用 files/ 或 cache/ 内的绝对路径。
   * 这条检查是「JS 传入不可信路径」的最后一道防线。
   */
  private fun resolveOutputFile(outputPath: String): File {
    if (outputPath.isBlank()) throw IllegalArgumentException("输出路径为空")
    val file = File(outputPath)
    if (!file.isAbsolute) throw IllegalArgumentException("输出路径必须是绝对路径")
    val canonical = file.canonicalFile
    val roots = listOf(context.filesDir.canonicalFile, context.cacheDir.canonicalFile)
    if (roots.none { canonical.path.startsWith(it.path + File.separator) || canonical.path == it.path }) {
      throw IllegalArgumentException("输出路径必须位于应用私有目录内")
    }
    return canonical
  }

  private fun mimeOf(format: String): String = when (format) {
    "png" -> "image/png"
    "webp" -> "image/webp"
    else -> "image/jpeg"
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
