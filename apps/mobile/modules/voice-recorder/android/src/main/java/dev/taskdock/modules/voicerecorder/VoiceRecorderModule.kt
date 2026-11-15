// 语音速记的原生录音/回放（Android）。不引入 expo-av/expo-audio 依赖：
// MediaRecorder + MediaPlayer 足够覆盖「录 → 停 → 试听 → 删除」这条链路。
//
// 设计边界：
// - 只写应用私有目录 `filesDir/capture-audio/`，文件路径由 Kotlin 生成，JS 不能传任意路径；
// - 录音格式固定 AAC in MPEG-4（.m4a），单声道 44.1kHz 96kbps，普通手机 1 分钟约 0.7MB；
// - 权限：调用方（JS）必须先拿到 RECORD_AUDIO；模块再校验一次，缺失时 fail-closed；
// - 不做任何语音识别：本机能否离线转写取决于系统能力，见 docs/mobile/14-capture.md；
// - 隐私：不写日志、不回显录音内容；stop 时只回传路径/时长/字节数。
package dev.taskdock.modules.voicerecorder

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class VoiceRecorderModule : Module() {
  private var recorder: MediaRecorder? = null
  private var player: MediaPlayer? = null
  private var currentFile: File? = null
  private var startedAtElapsedMs = 0L

  private fun requireContext(): Context {
    val context = appContext.reactContext ?: throw IllegalStateException("应用上下文不可用，请重启应用")
    return context
  }

  private fun audioDir(): File {
    val dir = File(requireContext().filesDir, "capture-audio")
    if (!dir.exists() && !dir.mkdirs()) {
      throw IllegalStateException("无法创建录音目录，请检查存储空间")
    }
    return dir
  }

  private fun hasPermission(context: Context): Boolean {
    return context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
  }

  /**
   * 只允许访问应用私有存储内的文件：防止 JS 传入任意路径读写/删除应用数据。
   *
   * 录音刚录完时在 `filesDir/capture-audio/`，进入采集暂存后会被复制到
   * `filesDir/capture/`（统一附件目录），粘贴到收集箱后仍在同一私有根下。
   * 因此这里按「应用私有根」而不是单一录音目录校验，同时保留越界拦截。
   */
  private fun assertInsideAppStorage(path: String): File {
    val context = requireContext()
    val roots = listOf(context.filesDir, context.cacheDir, context.noBackupFilesDir)
      .map { it.canonicalFile }
    val file = File(path).canonicalFile
    val allowed = roots.any { root -> file.path.startsWith(root.path + File.separator) }
    if (!allowed) {
      throw IllegalArgumentException("文件不在应用私有存储内")
    }
    return file
  }

  private fun newRecorder(context: Context): MediaRecorder {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      MediaRecorder(context)
    } else {
      @Suppress("DEPRECATION")
      MediaRecorder()
    }
  }

  private fun releaseRecorder(discard: Boolean) {
    val active = recorder
    recorder = null
    if (active != null) {
      try {
        active.stop()
      } catch (_: RuntimeException) {
        // 未真正开始时 stop 会抛；此时文件也不完整，下面按 discard 处理
      }
      try {
        active.reset()
      } catch (_: RuntimeException) {
        // reset 失败不影响 release
      }
      active.release()
    }
    if (discard) {
      val file = currentFile
      currentFile = null
      if (file != null && file.exists()) file.delete()
    }
    startedAtElapsedMs = 0L
  }

  private fun stopPlayer() {
    val active = player
    player = null
    if (active != null) {
      try {
        if (active.isPlaying) active.stop()
      } catch (_: IllegalStateException) {
        // 已停止/已释放
      }
      active.release()
    }
  }

  override fun definition() = ModuleDefinition {
    Name("VoiceRecorder")

    Function("startRecording") { fileName: String? ->
      val context = requireContext()
      if (!hasPermission(context)) {
        throw IllegalStateException("没有录音权限，请在系统设置中允许 TaskDock 使用麦克风")
      }
      if (recorder != null) {
        throw IllegalStateException("已有录音正在进行")
      }
      stopPlayer()

      val safeName = (fileName ?: "voice")
        .replace(Regex("[^A-Za-z0-9_-]"), "_")
        .take(48)
        .ifEmpty { "voice" }
      val file = File(audioDir(), "${safeName}_${System.currentTimeMillis()}.m4a")

      val active = newRecorder(context)
      try {
        active.setAudioSource(MediaRecorder.AudioSource.MIC)
        active.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        active.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        active.setAudioChannels(1)
        active.setAudioSamplingRate(44100)
        active.setAudioEncodingBitRate(96000)
        active.setOutputFile(file.absolutePath)
        active.prepare()
        active.start()
      } catch (error: Exception) {
        try {
          active.release()
        } catch (_: RuntimeException) {
          // 释放失败不覆盖原始错误
        }
        if (file.exists()) file.delete()
        throw IllegalStateException("开始录音失败，请检查麦克风是否被其他应用占用")
      }

      recorder = active
      currentFile = file
      startedAtElapsedMs = SystemClock.elapsedRealtime()
      mapOf("path" to file.absolutePath, "startedAt" to System.currentTimeMillis())
    }

    Function("stopRecording") {
      val active = recorder ?: throw IllegalStateException("当前没有进行中的录音")
      val file = currentFile
      val durationMs = if (startedAtElapsedMs > 0) {
        SystemClock.elapsedRealtime() - startedAtElapsedMs
      } else {
        0L
      }
      releaseRecorder(discard = false)
      if (file == null || !file.exists() || file.length() <= 0L) {
        if (file != null && file.exists()) file.delete()
        throw IllegalStateException("录音文件为空，请重新录制")
      }
      mapOf(
        "path" to file.absolutePath,
        "durationMs" to durationMs,
        "size" to file.length(),
      )
    }

    Function("cancelRecording") {
      releaseAll()
      null
    }

    Function("getState") {
      mapOf(
        "recording" to (recorder != null),
        "path" to currentFile?.absolutePath,
        "playing" to (player?.let {
          try {
            it.isPlaying
          } catch (_: IllegalStateException) {
            false
          }
        } ?: false),
      )
    }

    Function("play") { path: String ->
      stopPlayer()
      val file = assertInsideAppStorage(path)
      if (!file.exists()) throw IllegalStateException("录音文件已不存在")
      val context = requireContext()
      val active = MediaPlayer()
      try {
        active.setDataSource(file.absolutePath)
        active.setOnCompletionListener { completed ->
          try {
            completed.release()
          } catch (_: RuntimeException) {
            // 释放失败无需处理
          }
          if (player == completed) player = null
        }
        active.prepare()
        active.start()
      } catch (error: Exception) {
        try {
          active.release()
        } catch (_: RuntimeException) {
          // 同上
        }
        throw IllegalStateException("试听失败，请重新录制或稍后再试")
      }
      player = active
      null
    }

    Function("stopPlayback") {
      stopPlayer()
      null
    }

    Function("deleteFile") { path: String ->
      stopPlayer()
      val file = assertInsideAppStorage(path)
      if (file.exists() && !file.delete()) {
        throw IllegalStateException("删除录音文件失败")
      }
      null
    }
  }

  /**
   * 清理入口。Expo SDK 58 的 Module 基类没有可覆写的 onDestroy（编译期核对过），
   * 因此不挂生命周期钩子，改由 JS 在离开采集页/取消时显式调用 cancelRecording；
   * 进程被系统回收时 MediaPlayer/MediaRecorder 随进程释放，不会留下后台录音。
   */
  private fun releaseAll(discard: Boolean = true) {
    releaseRecorder(discard)
    stopPlayer()
  }
}
