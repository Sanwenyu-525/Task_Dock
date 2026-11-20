// 本地 Expo module：系统剪贴板读写（Android ClipboardManager）。
//
// 实现要点：
// - ClipboardManager 必须在主线程访问，这里把调用 post 到主线程并最多等待 3 秒；
// - 读失败/无内容返回 null（JS 提示「剪贴板为空」），不抛异常打断工具流程；
// - 不申请权限、不注册监听器、不写日志、不记录剪贴板内容。
package dev.taskdock.modules.clipboard

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ClipboardModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context unavailable" }

  private val mainHandler = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("TaskDockClipboard")

    AsyncFunction("getTextAsync") {
      readClipboard()
    }

    AsyncFunction("setTextAsync") { text: String ->
      writeClipboard(text)
      true
    }
  }

  private fun readClipboard(): String? {
    if (Looper.myLooper() == Looper.getMainLooper()) return readClipboardNow()

    var result: String? = null
    val latch = CountDownLatch(1)
    mainHandler.post {
      try {
        result = readClipboardNow()
      } finally {
        latch.countDown()
      }
    }
    // 超时返回 null：不让一次剪贴板读取卡住工具页。
    latch.await(3, TimeUnit.SECONDS)
    return result
  }

  private fun readClipboardNow(): String? {
    return try {
      val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        ?: return null
      val clip = manager.primaryClip ?: return null
      if (clip.itemCount == 0) return null
      val text = clip.getItemAt(0).coerceToText(context)?.toString()
      if (text.isNullOrEmpty()) null else text
    } catch (error: Exception) {
      // 后台读取被系统拒绝 / ROM 限制：按「读不到」处理，由 UI 提示用户。
      // 只记异常类名 + 脱敏原因（SafeLog 会截断并脱敏），绝不写剪贴板正文/路径。
      SafeLog.e("clipboard", "读取剪贴板失败: ${error.javaClass.simpleName}: ${error.message ?: ""}")
      null
    }
  }

  private fun writeClipboard(text: String) {
    val action = {
      val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
      if (manager != null) {
        manager.setPrimaryClip(ClipData.newPlainText("TaskDock", text))
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      action()
    } else {
      val latch = CountDownLatch(1)
      mainHandler.post {
        try {
          action()
        } finally {
          latch.countDown()
        }
      }
      latch.await(3, TimeUnit.SECONDS)
    }
  }
}
