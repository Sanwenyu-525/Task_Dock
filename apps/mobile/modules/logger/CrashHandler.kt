// CrashHandler：UncaughtExceptionHandler 崩溃捕获（设计 §5.2 / §5.3）。
//
// 行为契约：
// - install 幂等：重复调用不会链式包裹（对应桌面端 panic_hook 一期结论的教训）；
// - 捕获崩溃 → 在**崩溃线程上同步**写本地崩溃文件（沙盒 filesDir/logs，含时间/线程/
//   异常类名/脱敏后的首行消息/栈顶若干帧——**不含业务数据**：不写 intent、数据库、
//   剪贴板、文件路径正文）→ **委托原 handler**，绝不吞崩溃，系统照常终止进程；
// - 崩溃文件 ≤ 5 个、保留 7 天：install 时清理，写文件时超限即删最旧。
//
// 写文件失败只静默放弃（崩溃流程不受影响）；不做任何上传——用户主动导出诊断时才读取。
package dev.taskdock.modules.logger

import android.content.Context
import android.os.Process
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

internal class CrashHandler(
  private val appContext: Context,
  private val previous: Thread.UncaughtExceptionHandler?,
) : Thread.UncaughtExceptionHandler {
  companion object {
    private const val MAX_CRASH_FILES = 5
    private const val RETENTION_MS = 7L * 24 * 60 * 60 * 1000
    private const val MAX_FRAMES = 20

    /** 幂等安装：当前 handler 已是本类（或链上已有）时不再次包裹。 */
    fun install(appContext: Context) {
      val current = Thread.getDefaultUncaughtExceptionHandler()
      if (current is CrashHandler) return
      Thread.setDefaultUncaughtExceptionHandler(CrashHandler(appContext, current))
      pruneCrashFiles(appContext)
    }

    /** 沙盒日志目录（与 FileLogSink 同目录），避免两处各自 mkdir 漂移。 */
    internal fun logsDir(appContext: Context): File =
      File(appContext.filesDir, FileLogSink.DIR_NAME).apply { mkdirs() }

    /** 按保留期与数量上限清理历史崩溃文件；任何失败都不影响安装流程。 */
    private fun pruneCrashFiles(appContext: Context) {
      try {
        val files = logsDir(appContext).listFiles { file -> file.name.startsWith("crash-") }
          ?: return
        val deadline = System.currentTimeMillis() - RETENTION_MS
        for (file in files) {
          if (file.lastModified() < deadline) file.delete()
        }
        // 数量超限时删最旧（mtime 排序，取前 N 个删除）。
        files.filter { it.exists() }
          .sortedBy { it.lastModified() }
          .dropLast(MAX_CRASH_FILES)
          .forEach { it.delete() }
      } catch (_: Throwable) {
        // 清理失败不阻塞崩溃处理器的安装。
      }
    }
  }

  override fun uncaughtException(thread: Thread, throwable: Throwable) {
    try {
      writeCrashFile(thread, throwable)
    } catch (_: Throwable) {
      // 崩溃日志写失败：放弃记录，把崩溃原样交给系统。
    }
    // 委托原 handler（可能为 null = 无默认处理）：绝不吞崩溃，进程照常终止。
    previous?.uncaughtException(thread, throwable)
  }

  private fun writeCrashFile(thread: Thread, throwable: Throwable) {
    val dir = logsDir(appContext)
    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
    val file = File(dir, "crash-$stamp-${Process.myPid()}.txt")

    // 内容只有元数据：时间 / 线程 / 异常类名 / 脱敏截断后的首行消息 / 栈顶帧。
    // 消息走 SafeLog.sanitizeText（与 JS 同规则），防止异常文本夹带路径或正文。
    val frames = throwable.stackTrace.take(MAX_FRAMES)
      .joinToString("\n") { frame -> "  at ${frame.className}.${frame.methodName}(${frame.lineNumber})" }
    val text = buildString {
      append("time: ").append(System.currentTimeMillis()).append('\n')
      append("thread: ").append(SafeLog.sanitizeText(thread.name)).append('\n')
      append("exception: ").append(throwable.javaClass.name).append('\n')
      append("message: ").append(SafeLog.sanitizeText(throwable.message ?: "")).append('\n')
      append("frames:\n").append(frames)
    }
    FileOutputStream(file).use { out ->
      out.write(text.toByteArray(Charsets.UTF_8))
      out.flush()
      out.fd.sync()
    }
  }
}
