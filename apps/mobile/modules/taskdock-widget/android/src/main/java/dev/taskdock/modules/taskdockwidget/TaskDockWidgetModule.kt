// TaskDock 小组件的原生接口：JS 把最小快照 JSON 写进来，原生落 SharedPreferences
// 并刷新全部小组件实例（见 WidgetStore / WidgetRenderer）。不做任何轮询。
package dev.taskdock.modules.taskdockwidget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TaskDockWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name(MODULE_NAME)

    // 写快照并立即刷新全部实例：任务/收集箱变化或小组件偏好变化后由 JS 调用
    Function("pushWidgetSnapshot") { json: String ->
      val context = appContext.reactContext
        ?: throw CodedException("WIDGET_NO_CONTEXT", "应用上下文尚未就绪，无法更新小组件")
      WidgetStore.save(context, json)
      WidgetRenderer.updateAll(context)
    }

    // 不写快照、只用已有快照重渲染（appearance=system 在系统主题切换后重绘用）
    Function("refreshWidgets") {
      val context = appContext.reactContext ?: return@Function
      WidgetRenderer.updateAll(context)
    }

    // 请求把小组件直接添加到桌面（Android 8+ requestPinAppWidget，由系统弹确认框）。
    // 桌面（launcher）不支持时返回 supported=false，JS 侧回退为「长按桌面添加」引导。
    Function("requestPinWidget") { size: String ->
      val context = appContext.reactContext
        ?: throw CodedException("WIDGET_NO_CONTEXT", "应用上下文尚未就绪，无法请求添加小组件")
      val manager = AppWidgetManager.getInstance(context)
        ?: throw CodedException("WIDGET_MANAGER_UNAVAILABLE", "小组件服务不可用")
      val component = ComponentName(
        context,
        if (size == "2x2") TaskDockWidget2x2::class.java else TaskDockWidget4x2::class.java,
      )
      val supported = manager.isRequestPinAppWidgetSupported
      val requested = supported && manager.requestPinAppWidget(component, null, null)
      mapOf("supported" to supported, "requested" to requested)
    }
  }

  companion object {
    const val MODULE_NAME = "TaskDockWidget"
  }
}
