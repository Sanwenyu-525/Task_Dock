// FileLogSink：沙盒内滚动日志文件（设计 §5.2 / §5.3）。
//
// 边界（对齐 docs/acceptance/logging-phase2-current-state.md §2.4）：
// - 目录固定 context.filesDir/logs，不写外部存储，无权限要求；
// - 滚动：单文件软目标 ≤ 2 MB，最多 3 个（app.log / app.1.log / app.2.log），总量 ≤ 6 MB；
//   活动文件另有硬上限 4 MB，超出后有界丢弃并计数，绝不无限增长；
// - 保留 7 天：init 时按 mtime 清理（含崩溃文件，见 CrashHandler）；
// - 有界队列：单写线程异步执行，固定容量 + 分级配额；入队成功才计 pending，
//   任务 finally 减 pending；dispatcher 拒绝任务时恢复计数；队列满优先丢 TRACE/DEBUG/INFO，
//   WARN/ERROR 走独立有界配额；绝不阻塞 UI 线程、绝不因队列满崩溃；
// - 轮转降级：rename/delete/移动返回值逐一检查；rename 失败进入降级并指数退避，退避
//   窗口内不重复 rename；每条写入与 flush 都是恢复检查点（无常驻轮询定时器），文件
//   可用后自动清除降级状态；
// - 写失败（磁盘满等）只递增丢弃/失败计数，绝不抛错、绝不阻塞业务。
//
// 执行器接缝 [LogDispatcher]：生产为 HandlerThread + Handler；JVM 单测注入手动队列，
// 不依赖 android.os.Looper 桩。
//
// 行格式：单行 JSON（org.json 负责转义），字段 t/l/tag/m/md（md 为原生侧白名单
// 重新序列化后的最小化 metadata；LoggerModule 已先在原生侧脱敏，不依赖 JS 前提）。
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
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** 写任务执行器：生产 = HandlerThread/Handler；测试 = 手动队列。 */
internal interface LogDispatcher {
  /** 提交任务；false = 已关闭/拒绝，调用方需恢复队列计数。 */
  fun post(task: Runnable): Boolean

  /** 关闭执行器：不再接受新任务。 */
  fun quit()
}

internal object FileLogSink {
  /** 沙盒日志目录名（filesDir/logs）：CrashHandler 的崩溃文件共用同一目录。 */
  internal const val DIR_NAME = "logs"
  internal const val ACTIVE_NAME = "app.log"
  private const val MAX_FILE_BYTES = 2L * 1024 * 1024
  /** 活动文件硬上限：软目标 2 MB 之外的绝对天花板，超出后有界丢弃计数。 */
  private const val MAX_FILE_HARD_BYTES = 4L * 1024 * 1024
  private const val MAX_FILES = 3
  private const val RETENTION_MS = 7L * 24 * 60 * 60 * 1000
  private const val FLUSH_TIMEOUT_MS = 2_000L

  /** 队列总容量（默认值；测试可经内部接缝下调）。 */
  internal const val MAX_PENDING_LOGS = 256

  /** WARN/ERROR 独立保留配额：队列满时低级别先丢，高级别在该配额内有界保留。 */
  private const val HIGH_PRIORITY_RESERVED = 32

  /** 轮转退避：5 s 起指数翻倍，封顶 60 s。 */
  private const val ROTATE_BACKOFF_BASE_MS = 5_000L
  private const val ROTATE_BACKOFF_MAX_MS = 60_000L
  private const val ROTATE_BACKOFF_MAX_SHIFT = 10

  private var thread: HandlerThread? = null
  private var dispatcher: LogDispatcher? = null
  private var dir: File? = null
  private var writer: BufferedWriter? = null
  private var bytesInFile = 0L

  @Volatile
  private var shutdown = false

  // ---- 有界队列计数（原子；入队成功才计 pending，任务 finally 减 pending）----
  private val pendingCount = AtomicInteger(0)
  private val highPendingCount = AtomicInteger(0)

  /** 队列满 / 未初始化 / 已关闭时丢弃的总条数。 */
  val droppedCount = AtomicLong(0)
  private val droppedTrace = AtomicLong(0)
  private val droppedDebug = AtomicLong(0)
  private val droppedInfo = AtomicLong(0)
  private val droppedWarn = AtomicLong(0)
  private val droppedError = AtomicLong(0)
  private val droppedOther = AtomicLong(0)

  /** 打开/写入/刷盘/硬上限丢弃等 IO 失败计数。 */
  val writeFailures = AtomicLong(0)

  // ---- 轮转降级状态 ----
  @Volatile
  var rotateDegraded = false
    private set

  /** 轮转失败次数：连续失败用于指数退避；轮转恢复成功后清零（`resetForTest` 亦清零）。 */
  val rotateFailures = AtomicLong(0)

  /** 下一次可重试轮转的时刻（epoch ms）；0 = 无退避。诊断/测试可读。 */
  @Volatile
  internal var rotateRetryAt = 0L
    private set

  /** 时钟接缝：生产为系统时钟，测试可注入虚拟时钟推进退避窗口。 */
  internal var now: () -> Long = { System.currentTimeMillis() }

  /** 测试可调容量（默认 [MAX_PENDING_LOGS] / [HIGH_PRIORITY_RESERVED]）。 */
  internal var maxPendingLogs: Int = MAX_PENDING_LOGS
  internal var highReserved: Int = HIGH_PRIORITY_RESERVED

  /** 测试可调轮转阈值（默认 [MAX_FILE_BYTES] / [MAX_FILE_HARD_BYTES]）。 */
  internal var maxFileBytes: Long = MAX_FILE_BYTES
  internal var hardFileBytes: Long = MAX_FILE_HARD_BYTES

  /** 测试栅栏：写线程处理每条任务前回调（null = 不拦截，生产路径无开销）。 */
  internal var beforeWriteLine: (() -> Unit)? = null

  // ---- 生命周期 ----

  /** 幂等初始化：清理超期文件后启动单写线程。重复调用直接返回。 */
  fun init(appContext: Context) {
    if (dispatcher != null) return
    try {
      val logsDir = CrashHandler.logsDir(appContext)
      prune(logsDir)
      startHandlerThread(logsDir)
    } catch (_: Throwable) {
      // 初始化失败（极端沙盒异常）：维持空实现，append 会走静默丢弃。
    }
  }

  /** 测试接缝：用给定目录与执行器启动写线程并重置全部计数/降级状态。 */
  internal fun resetForTest(
    logsDir: File,
    dispatcher: LogDispatcher,
    clock: () -> Long = { System.currentTimeMillis() },
  ) {
    shutdown()
    synchronized(this) {
      shutdown = false
      now = clock
      dir = logsDir
      writer = null
      bytesInFile = 0
      pendingCount.set(0)
      highPendingCount.set(0)
      droppedCount.set(0)
      writeFailures.set(0)
      rotateFailures.set(0)
      droppedTrace.set(0); droppedDebug.set(0); droppedInfo.set(0)
      droppedWarn.set(0); droppedError.set(0); droppedOther.set(0)
      rotateDegraded = false
      rotateRetryAt = 0L
      maxPendingLogs = MAX_PENDING_LOGS
      highReserved = HIGH_PRIORITY_RESERVED
      maxFileBytes = MAX_FILE_BYTES
      hardFileBytes = MAX_FILE_HARD_BYTES
      beforeWriteLine = null
      logsDir.mkdirs()
      this.dispatcher = dispatcher
    }
  }

  private fun startHandlerThread(logsDir: File) {
    synchronized(this) {
      if (dispatcher != null) return
      dir = logsDir
      val newThread = HandlerThread("taskdock-logs").apply { start() }
      thread = newThread
      val handler = Handler(newThread.looper)
      dispatcher = HandlerDispatcher(handler)
    }
  }

  private class HandlerDispatcher(private val handler: Handler) : LogDispatcher {
    override fun post(task: Runnable): Boolean = handler.post(task)
    override fun quit() = Unit
  }

  // ---- 入队（任何线程可调，非阻塞）----

  /** 非阻塞入队：未初始化/已关闭/队列满时静默丢弃并按级别计数。 */
  fun append(level: String, tag: String, message: String, metadataJson: String? = null) {
    if (shutdown) {
      drop(level)
      return
    }
    val high = level == "warn" || level == "error"
    if (!tryEnqueue(high)) {
      drop(level)
      return
    }
    val d = dispatcher
    if (d == null) {
      release(high)
      drop(level)
      return
    }
    val accepted = d.post {
      try {
        writeLine(level, tag, message, metadataJson)
      } catch (_: Throwable) {
        writeFailures.incrementAndGet()
      } finally {
        release(high)
      }
    }
    if (!accepted) {
      // 执行器已退出/拒绝任务：恢复计数，按丢弃处理。
      release(high)
      drop(level)
    }
  }

  /** 有界配额入队；成功才计 pending。 */
  private fun tryEnqueue(high: Boolean): Boolean {
    synchronized(this) {
      if (shutdown) return false
      val pending = pendingCount.get()
      if (pending >= maxPendingLogs) return false
      if (high) {
        if (highPendingCount.get() >= highReserved) return false
        highPendingCount.incrementAndGet()
      } else {
        val lowSlots = maxPendingLogs - highReserved
        if (pending - highPendingCount.get() >= lowSlots) return false
      }
      pendingCount.incrementAndGet()
      return true
    }
  }

  private fun release(high: Boolean) {
    pendingCount.decrementAndGet()
    if (high) highPendingCount.decrementAndGet()
  }

  private fun drop(level: String) {
    droppedCount.incrementAndGet()
    when (level) {
      "trace" -> droppedTrace.incrementAndGet()
      "debug" -> droppedDebug.incrementAndGet()
      "info" -> droppedInfo.incrementAndGet()
      "warn" -> droppedWarn.incrementAndGet()
      "error" -> droppedError.incrementAndGet()
      else -> droppedOther.incrementAndGet()
    }
  }

  // ---- 刷盘与关闭 ----

  /** 有界等待刷盘；true = 已 flush（或无内容/已关闭）。供 App 退后台 / 模块销毁调用。 */
  fun flushBlocking(timeoutMs: Long = FLUSH_TIMEOUT_MS): Boolean {
    val d = dispatcher ?: return true
    val latch = CountDownLatch(1)
    val posted = d.post {
      try {
        flushWriter()
      } finally {
        latch.countDown()
      }
    }
    if (!posted) return true
    return try {
      latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      false
    }
  }

  /** 模块销毁：标记关闭 → 刷盘 → 安全退出写线程；之后 append 静默丢弃并计数。 */
  fun shutdown() {
    val currentThread: HandlerThread?
    synchronized(this) {
      if (shutdown) return
      shutdown = true
      currentThread = thread
      try {
        dispatcher?.post { flushWriter() }
      } catch (_: Throwable) {
        // 关闭路径上的刷盘失败不阻断退出。
      }
      dispatcher?.quit()
    }
    currentThread?.quitSafely()
    synchronized(this) {
      dispatcher = null
      thread = null
    }
    // 队列中剩余任务不再执行：pending 计数归零，避免长期泄漏。
    pendingCount.set(0)
    highPendingCount.set(0)
  }

  // ---- 以下方法只在写线程上执行 ----

  private fun writeLine(level: String, tag: String, message: String, metadataJson: String?) {
    beforeWriteLine?.invoke()
    val activeDir = dir ?: run {
      writeFailures.incrementAndGet()
      return
    }
    var out = try {
      writer ?: openWriter(activeDir)
    } catch (_: Throwable) {
      writeFailures.incrementAndGet()
      return
    }

    // 硬上限：退避到期先尝试一次 rotate（含降级判定与恢复）；rotate 之后活动文件仍超限
    // 才有界丢弃并计数。退避未到期不重试、不阻塞写线程；不得因一次 rename 失败永久停止尝试。
    if (bytesInFile >= hardFileBytes) {
      if (rotateRetryDue()) {
        rotate(activeDir, out)
        out = writer ?: try {
          openWriter(activeDir)
        } catch (_: Throwable) {
          writeFailures.incrementAndGet()
          return
        }
      }
      if (bytesInFile >= hardFileBytes) {
        writeFailures.incrementAndGet()
        return
      }
    }

    val line = JSONObject().apply {
      put("t", now())
      put("l", level)
      put("tag", tag)
      put("m", message)
      if (!metadataJson.isNullOrBlank()) {
        // metadata 已在原生侧白名单 + 类型/长度限制后重新序列化；这里解析失败只丢
        // metadata，不丢整条日志。
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
    try {
      out.write(line)
      out.write("\n")
      bytesInFile += lineBytes + 1
    } catch (_: Throwable) {
      writeFailures.incrementAndGet()
      return
    }

    if (bytesInFile >= maxFileBytes) {
      // 降级退避窗口内跳过 rotate 判断，不重复 rename（消除失败风暴）；
      // 恢复检查点就在每条写入：窗口一过，下一条写入即重试。
      if (rotateRetryDue()) {
        rotate(activeDir, out)
      }
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

  /**
   * app.log → app.1.log → app.2.log；超过 MAX_FILES 删最旧，保证总量 ≤ 6 MB。
   * 每一个 delete/rename/移动的返回值都检查；任一失败进入降级并按指数退避重试。
   */
  private fun rotate(activeDir: File, out: BufferedWriter) {
    try {
      out.flush()
      out.close()
    } catch (_: Throwable) {
      writeFailures.incrementAndGet()
    }
    writer = null

    var ok = true
    // 先删最旧归档；删除失败计入失败并继续后续步骤（不抛错）。
    val oldest = File(activeDir, "app.${MAX_FILES - 1}.log")
    if (oldest.exists() && !oldest.delete()) ok = false
    // 已有归档整体后移一位；任一移动失败即标记。
    for (index in MAX_FILES - 2 downTo 1) {
      val from = File(activeDir, "app.$index.log")
      val to = File(activeDir, "app.${index + 1}.log")
      if (from.exists() && !from.renameTo(to)) {
        ok = false
        break
      }
    }
    val active = File(activeDir, ACTIVE_NAME)
    if (active.exists() && !active.renameTo(File(activeDir, "app.1.log"))) ok = false

    if (!ok) {
      enterDegraded()
      // 重新打开追加句柄继续写；打开失败由上层 writeLine 计数。
      try {
        openWriter(activeDir)
      } catch (_: Throwable) {
        writeFailures.incrementAndGet()
      }
      return
    }

    // 恢复成功：清除降级状态与累计轮转失败计数，后续日志继续正常落盘。
    rotateDegraded = false
    rotateFailures.set(0)
    rotateRetryAt = 0L
    bytesInFile = 0
    openWriter(activeDir)
  }

  /** 进入降级：累计失败次数并按指数退避计算下一次可重试时刻。 */
  private fun enterDegraded() {
    val failures = rotateFailures.incrementAndGet()
    rotateRetryAt = now() + rotateBackoff(failures)
    rotateDegraded = true
  }

  /** 指数退避：5 s 起翻倍，封顶 60 s，位移上限 [ROTATE_BACKOFF_MAX_SHIFT]。 */
  internal fun rotateBackoff(failures: Long): Long {
    val shift = minOf((failures - 1).toInt(), ROTATE_BACKOFF_MAX_SHIFT)
    return minOf(ROTATE_BACKOFF_BASE_MS shl shift, ROTATE_BACKOFF_MAX_MS)
  }

  /** 退避是否已到可重试时刻；非降级状态恒 true。 */
  internal fun rotateRetryDue(): Boolean = !rotateDegraded || now() >= rotateRetryAt

  private fun flushWriter() {
    try {
      writer?.flush()
    } catch (_: Throwable) {
      writeFailures.incrementAndGet()
    }
    // flush 也是恢复检查点：降级且退避已到时，顺手尝试一次轮转。
    val activeDir = dir
    val out = writer
    if (activeDir != null && out != null && rotateDegraded && rotateRetryDue()) {
      rotate(activeDir, out)
    }
  }

  /** 保留 7 天：删除 mtime 超期的日志与崩溃文件（active 文件由轮转天然有界）。 */
  private fun prune(activeDir: File) {
    val deadline = now() - RETENTION_MS
    val files = activeDir.listFiles() ?: return
    for (file in files) {
      if (file.lastModified() < deadline && !file.delete()) {
        writeFailures.incrementAndGet()
      }
    }
  }

  // ---- 诊断/测试读取 ----

  internal fun pendingCount(): Int = pendingCount.get()

  internal fun bytesInFile(): Long = bytesInFile

  internal fun activeFileName(): String = ACTIVE_NAME

  internal fun droppedByLevel(level: String): Long = when (level) {
    "trace" -> droppedTrace.get()
    "debug" -> droppedDebug.get()
    "info" -> droppedInfo.get()
    "warn" -> droppedWarn.get()
    "error" -> droppedError.get()
    else -> droppedOther.get()
  }
}
