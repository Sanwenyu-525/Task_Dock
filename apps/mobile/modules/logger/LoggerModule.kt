// 本地 Expo 模块：SafeLog / CrashHandler / FileLogSink（Android 本地日志，设计 §5.2）。
//
// 暴露给 JS 的 API（经 src/lib/safeLog.ts 统一使用，页面不得直接调用）：
// - write(level, tag, message, metadataJson): 入队一条日志——Logcat 立即写（SafeLog
//   是唯一 android.util.Log 入口），文件走 FileLogSink 单线程异步落盘；
// - flush(): 有界等待把文件缓冲刷盘（App 退后台 / 关键操作后调用）。
//
// 生命周期：模块创建（即 App 首次 import safeLog）时安装 CrashHandler 并初始化文件
// sink——这是 JS 侧能做到的最早时机；OnDestroy 刷盘后停掉写线程，无常驻定时器。
// 日志纪律：本模块自身不记录任何业务数据；metadata 由 JS 侧脱敏后才传入。
package dev.taskdock.modules.logger

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LoggerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TaskDockLogger")

    OnCreate {
      val appContext = appContext.reactContext?.applicationContext
      if (appContext != null) {
        // 幂等：CrashHandler/FileLogSink 各自防重复安装。
        CrashHandler.install(appContext)
        FileLogSink.init(appContext)
      }
    }

    Function("write") { level: String, tag: String, message: String, metadataJson: String? ->
      SafeLog.write(level, tag, message)
      FileLogSink.append(level, tag, message, metadataJson)
    }

    AsyncFunction("flush") { promise: Promise ->
      // 有界等待（FileLogSink 内部 2s 上限）：退后台/关键操作后的显式刷盘。
      promise.resolve(FileLogSink.flushBlocking())
    }

    OnDestroy {
      FileLogSink.shutdown()
    }
  }
}
