// TaskDock 小组件的原生接口：JS 把最小快照 JSON 写进来，原生落 SharedPreferences
// 并刷新全部小组件实例（见 WidgetStore / WidgetRenderer）。不做任何轮询。
package dev.taskdock.modules.taskdockwidget

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
  }

  companion object {
    const val MODULE_NAME = "TaskDockWidget"
  }
}
