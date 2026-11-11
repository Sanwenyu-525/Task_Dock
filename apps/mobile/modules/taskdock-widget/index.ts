// TaskDock 主屏小组件的 JS 侧接口：只暴露「推快照」「重渲染」两个动作。
// 快照内容由 src/lib/widgetSnapshot.ts 构建（只含标题、勾选态、计数、时间戳）。
import { requireOptionalNativeModule } from "expo-modules-core";

interface TaskDockWidgetNativeModule {
  /** 写入快照 JSON（SharedPreferences）并刷新全部小组件实例 */
  pushWidgetSnapshot(json: string): void;
  /** 不写快照，用已有快照重渲染（appearance=system 系统主题切换后重绘用） */
  refreshWidgets(): void;
}

const native = requireOptionalNativeModule<TaskDockWidgetNativeModule>("TaskDockWidget");

export const taskDockWidgetAvailable = native != null;

/** 推快照并刷新；原生模块缺失（旧构建/其他平台）或调用失败时返回 false。 */
export function pushWidgetSnapshot(json: string): boolean {
  if (!native) return false;
  try {
    native.pushWidgetSnapshot(json);
    return true;
  } catch {
    return false;
  }
}

export function refreshWidgets(): boolean {
  if (!native) return false;
  try {
    native.refreshWidgets();
    return true;
  } catch {
    return false;
  }
}
