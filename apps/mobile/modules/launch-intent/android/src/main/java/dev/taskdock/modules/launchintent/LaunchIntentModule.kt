// 应用图标长按快捷方式 → 采集中心的落地模块。
//
// 为什么不直接让快捷方式指向 MainActivity：
// Android 静态快捷方式若指向已在运行的 Activity，只会触发 onNewIntent；Expo 的模块
// API 没有暴露 onNewIntent 钩子，JS 侧无法可靠拿到「用户点了哪个快捷方式」。
//
// 这里用一个无界面的 ShortcutActivity 做跳板：
// 1) 系统点击快捷方式 → ShortcutActivity（带 QUICK_ACTION extra）；
// 2) 它把动作写入 SharedPreferences（带时间戳，120s 内有效）；
// 3) 再以标准 LAUNCHER intent 打开 MainActivity（冷启动/热启动都走同一条路径）；
// 4) JS 在启动与每次回到前台时调用 takePendingAction() 读取并消费。
//
// 隐私/安全：只接受四个白名单动作；不记录任何内容；跳板 Activity 无界面、不进最近任务。
package dev.taskdock.modules.launchintent

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

object LaunchActionStore {
  const val EXTRA_ACTION = "dev.taskdock.mobile.QUICK_ACTION"
  const val PREF_NAME = "taskdock_launch_action"
  const val KEY_ACTION = "action"
  const val KEY_AT = "at"
  const val TTL_MS = 120_000L

  val ALLOWED = setOf("capture", "camera", "voice", "task")

  fun save(context: Context, action: String) {
    if (action !in ALLOWED) return
    context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_ACTION, action)
      .putLong(KEY_AT, System.currentTimeMillis())
      .apply()
  }

  fun take(context: Context): Map<String, Any>? {
    val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
    val action = prefs.getString(KEY_ACTION, null) ?: return null
    val at = prefs.getLong(KEY_AT, 0L)
    prefs.edit().remove(KEY_ACTION).remove(KEY_AT).apply()
    if (action !in ALLOWED) return null
    // 过期动作不再生效：避免用户很久以后回到应用被带到采集页
    if (System.currentTimeMillis() - at > TTL_MS) return null
    return mapOf("action" to action, "at" to at)
  }
}

/** 无界面跳板：写待处理动作后立刻拉起主 Activity。 */
class ShortcutActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val explicit = intent?.getStringExtra(LaunchActionStore.EXTRA_ACTION)
    val fallback = intent?.action?.substringAfterLast('.')?.lowercase()
    val action = explicit ?: fallback
    if (action != null) LaunchActionStore.save(this, action)

    val launch = Intent(Intent.ACTION_MAIN).apply {
      addCategory(Intent.CATEGORY_LAUNCHER)
      setClassName(packageName, "$packageName.MainActivity")
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
    }
    try {
      startActivity(launch)
    } finally {
      finish()
    }
  }
}

class LaunchIntentModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaunchIntent")

    Function("takePendingAction") {
      val context = appContext.reactContext?.applicationContext ?: return@Function null
      LaunchActionStore.take(context)
    }
  }
}
