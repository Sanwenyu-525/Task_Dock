// RemoteViews 渲染：按快照的 content/appearance 选择文案、计数、行内容与明暗配色。
//
// 配色规则：RemoteViews 拿不到 React Native 的 token 系统，这里把 tokens.ts 的
// 对应值镜像进 res/values/taskdock_widget_colors.xml（映射表见 docs/mobile/10-widget.md），
// 明暗两套 drawable/color 由渲染时按快照 appearance 选择——appearance=system 时
// 读系统夜间模式，快照推送时或系统主题变化后（应用回到前台触发重推）重渲染。
//
// RemoteViews 约束：不能动态增删子视图，行槽位固定（4×2 三行、2×2 一行），
// 勾选指示用固定尺寸的空 TextView 换背景 drawable 实现（裸 View 不在 RemoteViews 白名单）。
package dev.taskdock.modules.taskdockwidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import org.json.JSONArray

object WidgetRenderer {
  private data class RowSlots(val containerId: Int, val checkId: Int, val textId: Int)

  private val ROWS_4X2 = listOf(
    RowSlots(R.id.taskdock_widget_row1, R.id.taskdock_widget_row1_check, R.id.taskdock_widget_row1_text),
    RowSlots(R.id.taskdock_widget_row2, R.id.taskdock_widget_row2_check, R.id.taskdock_widget_row2_text),
    RowSlots(R.id.taskdock_widget_row3, R.id.taskdock_widget_row3_check, R.id.taskdock_widget_row3_text),
  )

  private val ROWS_2X2 = listOf(
    RowSlots(R.id.taskdock_widget_row1, R.id.taskdock_widget_row1_check, R.id.taskdock_widget_row1_text),
  )

  fun updateAll(context: Context) {
    val manager = AppWidgetManager.getInstance(context) ?: return
    updateComponent(context, manager, ComponentName(context, TaskDockWidget4x2::class.java))
    updateComponent(context, manager, ComponentName(context, TaskDockWidget2x2::class.java))
  }

  fun updateComponent(context: Context, manager: AppWidgetManager, component: ComponentName) {
    val ids = manager.getAppWidgetIds(component) ?: return
    if (ids.isEmpty()) return
    val snapshot = WidgetStore.load(context)
    val layoutRes = when (component.className) {
      TaskDockWidget2x2::class.java.name -> R.layout.taskdock_widget_2x2
      else -> R.layout.taskdock_widget_4x2
    }
    val views = render(context, snapshot, layoutRes)
    for (appWidgetId in ids) {
      manager.updateAppWidget(appWidgetId, views)
    }
  }

  fun render(context: Context, snapshot: org.json.JSONObject?, layoutRes: Int): RemoteViews {
    val views = RemoteViews(context.packageName, layoutRes)
    val content = snapshot?.optString("content", "today")?.takeIf { it.isNotEmpty() } ?: "today"
    val appearance = snapshot?.optString("appearance", "system")?.takeIf { it.isNotEmpty() } ?: "system"
    val dark = when (appearance) {
      "dark" -> true
      "light" -> false
      else -> isSystemDark(context)
    }

    applyColors(context, views, dark)
    applyHeader(context, views, snapshot, content, dark)
    applyRows(context, views, snapshot, if (layoutRes == R.layout.taskdock_widget_2x2) ROWS_2X2 else ROWS_4X2, dark)
    applyFooter(context, views, layoutRes)

    // 整卡点击 → 对应页面（收集箱内容进收集箱 Tab，任务内容进任务 Tab）
    val route = if (content == "captures") "taskdock://route/inbox" else "taskdock://route/tasks"
    views.setOnClickPendingIntent(R.id.taskdock_widget_root, openAppIntent(context, route))
    return views
  }

  private fun applyColors(context: Context, views: RemoteViews, dark: Boolean) {
    views.setInt(
      R.id.taskdock_widget_root,
      "setBackgroundResource",
      if (dark) R.drawable.taskdock_widget_card_dark else R.drawable.taskdock_widget_card_light,
    )
    val text = context.getColor(if (dark) R.color.taskdock_widget_text_dark else R.color.taskdock_widget_text_light)
    val muted = context.getColor(if (dark) R.color.taskdock_widget_muted_dark else R.color.taskdock_widget_muted_light)
    val faint = context.getColor(if (dark) R.color.taskdock_widget_faint_dark else R.color.taskdock_widget_faint_light)
    val accent = context.getColor(if (dark) R.color.taskdock_widget_accent_dark else R.color.taskdock_widget_accent_light)

    views.setTextColor(R.id.taskdock_widget_title, text)
    views.setTextColor(R.id.taskdock_widget_count, accent)
    views.setTextColor(R.id.taskdock_widget_empty, muted)
    views.setTextColor(R.id.taskdock_widget_footer, faint)
    for (row in ROWS_4X2) views.setTextColor(row.textId, text)
  }

  private fun applyHeader(
    context: Context,
    views: RemoteViews,
    snapshot: org.json.JSONObject?,
    content: String,
    dark: Boolean,
  ) {
    val titleRes = when (content) {
      "pending" -> R.string.taskdock_widget_title_pending
      "captures" -> R.string.taskdock_widget_title_captures
      else -> R.string.taskdock_widget_title_today
    }
    views.setTextViewText(R.id.taskdock_widget_title, context.getString(titleRes))

    val count = when (content) {
      "pending" -> snapshot?.optInt("pendingCount", 0) ?: 0
      "captures" -> snapshot?.optInt("captureCount", 0) ?: 0
      else -> snapshot?.optInt("todayCount", 0) ?: 0
    }
    views.setTextViewText(R.id.taskdock_widget_count, count.toString())
    views.setInt(
      R.id.taskdock_widget_count,
      "setBackgroundResource",
      if (dark) R.drawable.taskdock_widget_count_badge_dark else R.drawable.taskdock_widget_count_badge_light,
    )
  }

  private fun applyRows(
    context: Context,
    views: RemoteViews,
    snapshot: org.json.JSONObject?,
    rows: List<RowSlots>,
    dark: Boolean,
  ) {
    val items: JSONArray? = snapshot?.optJSONArray("items")
    var shown = 0
    if (items != null) {
      val limit = minOf(items.length(), rows.size)
      for (i in 0 until limit) {
        val item = items.optJSONObject(i) ?: continue
        val title = item.optString("t", "").ifEmpty { continue }
        val row = rows[shown]
        views.setViewVisibility(row.containerId, View.VISIBLE)
        views.setTextViewText(row.textId, title)
        views.setInt(
          row.checkId,
          "setBackgroundResource",
          when {
            item.optBoolean("done", false) && dark -> R.drawable.taskdock_widget_check_done_dark
            item.optBoolean("done", false) -> R.drawable.taskdock_widget_check_done_light
            dark -> R.drawable.taskdock_widget_check_pending_dark
            else -> R.drawable.taskdock_widget_check_pending_light
          },
        )
        shown += 1
      }
    }
    for (i in shown until rows.size) {
      views.setViewVisibility(rows[i].containerId, View.GONE)
    }

    val emptyText = snapshot?.optString("empty", "")?.takeIf { it.isNotEmpty() }
      ?: context.getString(R.string.taskdock_widget_empty_default)
    views.setTextViewText(R.id.taskdock_widget_empty, emptyText)
    views.setViewVisibility(R.id.taskdock_widget_empty, if (shown == 0) View.VISIBLE else View.GONE)
  }

  private fun applyFooter(context: Context, views: RemoteViews, layoutRes: Int) {
    val footerRes =
      if (layoutRes == R.layout.taskdock_widget_2x2) R.string.taskdock_widget_footer_2x2
      else R.string.taskdock_widget_footer_4x2
    views.setTextViewText(R.id.taskdock_widget_footer, context.getString(footerRes))
  }

  private fun openAppIntent(context: Context, route: String): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(route)).setPackage(context.packageName)
    return PendingIntent.getActivity(
      context,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun isSystemDark(context: Context): Boolean {
    val mode = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
    return mode == Configuration.UI_MODE_NIGHT_YES
  }
}
