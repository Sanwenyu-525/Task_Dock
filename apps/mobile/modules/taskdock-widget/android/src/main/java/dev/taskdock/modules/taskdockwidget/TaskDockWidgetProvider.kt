// TaskDock 主屏小组件（2×2 / 4×2）。两个尺寸各注册一个 receiver（见
// plugins/withTaskDockWidgets.js），共享同一份快照与渲染逻辑：
// - 无永久轮询：updatePeriodMillis=0，更新只由「应用内数据变化 → JS 推快照」驱动，
//   外加系统在开机/桌面重建时自发的 onUpdate（读同一份快照，不依赖应用进程存活）。
// - 点击进入应用：PendingIntent 打开 taskdock://route/<tab> 深链（冷启动可用）。
package dev.taskdock.modules.taskdockwidget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle

abstract class TaskDockWidgetBase : AppWidgetProvider() {
  protected abstract val layoutRes: Int

  override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
    val snapshot = WidgetStore.load(context)
    for (appWidgetId in appWidgetIds) {
      manager.updateAppWidget(appWidgetId, WidgetRenderer.render(context, snapshot, layoutRes))
    }
  }

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    val snapshot = WidgetStore.load(context)
    manager.updateAppWidget(appWidgetId, WidgetRenderer.render(context, snapshot, layoutRes))
  }
}

class TaskDockWidget4x2 : TaskDockWidgetBase() {
  override val layoutRes: Int = R.layout.taskdock_widget_4x2
}

class TaskDockWidget2x2 : TaskDockWidgetBase() {
  override val layoutRes: Int = R.layout.taskdock_widget_2x2
}
