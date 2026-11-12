// 快照持久化：JS 侧把最小必要数据（标题、勾选态、计数、时间戳）序列化成 JSON，
// 经 TaskDockWidgetModule 写入 SharedPreferences；AppWidgetProvider onUpdate /
// 开机重建时读同一份快照渲染。这是 App 与小组件之间唯一的共享数据通道。
//
// 安全边界：快照绝不写入配对令牌、密钥或同步元数据；标题在 JS 侧已截断到 60 字。
// JSON 解析失败按「无快照」处理，渲染空态，不抛异常（小组件不能把桌面拖崩）。
package dev.taskdock.modules.taskdockwidget

import android.content.Context
import org.json.JSONException
import org.json.JSONObject

object WidgetStore {
  private const val PREFS_NAME = "taskdock_widget"
  private const val KEY_SNAPSHOT = "snapshot_v1"

  fun save(context: Context, json: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_SNAPSHOT, json)
      .apply()
  }

  fun load(context: Context): JSONObject? {
    val raw = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .getString(KEY_SNAPSHOT, null) ?: return null
    return try {
      JSONObject(raw)
    } catch (_: JSONException) {
      null
    }
  }
}
