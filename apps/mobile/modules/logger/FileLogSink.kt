// FileLogSink：沙盒内滚动日志文件（设计 §5.2 / §5.3）。
//
// 边界（对齐 docs/acceptance/logging-phase2-current-state.md §2.4）：
// - 目录固定 context.filesDir/logs，不写外部存储，无权限要求；
// - 滚动：单文件 ≤ 2 MB，最多 3 个（app.log / app.1.log / app.2.log），总量 ≤ 6 MB；
// - 保留 7 天：init 时按 mtime 清理（含崩溃文件，见 CrashHandler）；
// - 无常驻定时器：HandlerThread 单线程异步写，只在有日志时活动；
// - 退出/后台 flush：shutdown()（模块 OnDestroy）与 JS flush()（App 退后台）触发；
// - 写失败（磁盘满等）只递增丢弃计数，绝不抛错、绝不阻塞业务。
//
// 行格式：单行 JSON（org.json 负责转义），字段 t/l/tag/m/md（md 为 JS 侧已脱敏的最小化 metadata）。
package dev.taskdock.modules.logger

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

internal object FileLogSink {
  /** 沙盒日志目录名（filesDir/logs）：CrashHandler 的崩溃文件共用同一目录。 */
  internal const val DIR_NAME = "logs"
  private const val ACTIVE_NAME = "app.log"
  private const val MAX_FILE_BYTES = 2L * 1024 * 1024
  private const val MAX_FILES = 3
  private const val RETENTION_MS = 7L * 24 * 60 * 60 * 1000
  private const val FLUSH_TIMEOUT_MS = 2_000L

  private var thread: HandlerThread? = null
  private var handler: Handler? = null
  private var dir: File? = null
  private var writer: BufferedWriter? = null
  private var bytesInFile = 0L

  /** 写失败/未初始化时丢弃的条数：只累计不上报（诊断导出可另行读取）。 */
  @Volatile
  var droppedCount: Long = 0
    private set

  /** 幂等初始化：清理超期文件后启动单写线程。重复调用直接返回。 */
  fun init(appContext: Context) {
    if (handler != null) return
    try {
      val logsDir = CrashHandler.logsDir(appContext)
      prune(logsDir)
      synchronized(this) {
        if (handler != null) return
        dir = logsDir
        val newThread = HandlerThread("taskdock-logs").apply { start() }
        thread = newThread
        handler = Handler(newThread.looper)
      }
    } catch (_: Throwable) {
      // 初始化失败（极端沙盒异常）：维持空实现，append 会走静默丢弃。
    }
  }

  /** 非阻塞入队：任何线程可调；未初始化/已关闭时静默丢弃（JS 侧内存缓冲仍在）。 */
  fun append(level: String, tag: String, message: String, metadataJson: String?) {
    val posted = handler ?: run {
      droppedCount += 1
      return
    }
    posted.post {
      try {
        writeLine(level, tag, message, metadataJson)
      } catch (_: Throwable) {
        droppedCount += 1
      }
    }
  }

  /** 有界等待刷盘；true = 已 flush（或无内容）。供 App 退后台 / 模块销毁调用。 */
  fun flushBlocking(timeoutMs: Long = FLUSH_TIMEOUT_MS): Boolean {
    val posted = handler ?: return true
    val latch = CountDownLatch(1)
    posted.post {
      try {
        flushWriter()
      } finally {
        latch.countDown()
      }
    }
    return try {
      latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      false
    }
  }

  /** 模块销毁：刷盘后安全退出写线程；之后 append 走静默丢弃。 */
  fun shutdown() {
    val currentThread = thread ?: return
    try {
      handler?.post { flushWriter() }
    } finally {
      currentThread.quitSafely()
    }
    synchronized(this) {
      handler = null
      thread = null
    }
  }

  // ---- 以下方法只在写线程上执行 ----

  private fun writeLine(level: String, tag: String, message: String, metadataJson: String?) {
    val activeDir = dir ?: run { droppedCount += 1; return }
    val out = writer ?: openWriter(activeDir)

    val line = JSONObject().apply {
      put("t", System.currentTimeMillis())
      put("l", level)
      put("tag", tag)
      put("m", message)
      if (metadataJson != null) {
        // JS 侧已按白名单脱敏；这里解析失败只丢 metadata，不丢整条日志。
        val md = try {
          JSONObject(metadataJson)
        } catch (_: Throwable) {
          null
        }
        if (md != null) putOpt("md", md)
      }
    }.toString()

    // 按实际 UTF-8 字节计数：中文一行 3 字节/字符，按 char 计会低估、突破 2 MB 上限。
    val lineBytes = line.toByteArray(Charsets.UTF_8).size
    out.write(line)
    out.write("\n")
    bytesInFile += lineBytes + 1
    if (bytesInFile >= MAX_FILE_BYTES) {
      rotate(activeDir, out)
    }
  }

  private fun openWriter(activeDir: File): BufferedWriter {
    val out = BufferedWriter(
      OutputStreamWriter(FileOutputStream(File(activeDir, ACTIVE_NAME), true), Charsets.UTF_8),
    )
    bytesInFile = File(activeDir, ACTIVE_NAME).length()
    writer = out
    return out
  }

  /** app.log → app.1.log → app.2.log；超过 MAX_FILES 删最旧，保证总量 ≤ 6 MB。 */
  private fun rotate(activeDir: File, out: BufferedWriter) {
    try {
      out.flush()
      out.close()
    } catch (_: Throwable) {
      // 关闭失败也继续轮转：旧句柄交给 GC/进程退出。
    }
    writer = null
    // 先删最旧归档，再把已有归档整体后移一位，最后 app.log → app.1.log。
    val oldest = File(activeDir, "app.${MAX_FILES - 1}.log")
    if (oldest.exists()) oldest.delete()
    for (index in MAX_FILES - 2 downTo 1) {
      val from = File(activeDir, "app.$index.log")
      val to = File(activeDir, "app.${index + 1}.log")
      if (from.exists()) from.renameTo(to)
    }
    val active = File(activeDir, ACTIVE_NAME)
    if (active.exists()) active.renameTo(File(activeDir, "app.1.log"))
    bytesInFile = 0
    openWriter(activeDir)
  }

  private fun flushWriter() {
    try {
      writer?.flush()
    } catch (_: Throwable) {
      // 刷盘失败不抛错：下一条写入继续尝试。
    }
  }

  /** 保留 7 天：删除 mtime 超期的日志与崩溃文件（active 文件由轮转天然有界）。 */
  private fun prune(activeDir: File) {
    val deadline = System.currentTimeMillis() - RETENTION_MS
    val files = activeDir.listFiles() ?: return
    for (file in files) {
      if (file.lastModified() < deadline) file.delete()
    }
  }
}
