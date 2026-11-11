// TaskDock 主屏小组件的 JS 侧接口：只暴露「推快照」「重渲染」「请求添加」三个动作。
// 快照内容由 src/lib/widgetSnapshot.ts 构建（只含标题、勾选态、计数、时间戳）。
import { requireOptionalNativeModule } from "expo-modules-core";

interface TaskDockWidgetNativeModule {
  /** 写入快照 JSON（SharedPreferences）并刷新全部小组件实例 */
  pushWidgetSnapshot(json: string): void;
  /** 不写快照，用已有快照重渲染（appearance=system 系统主题切换后重绘用） */
  refreshWidgets(): void;
  /** 请求系统弹出「添加小组件到桌面」确认（Android 8+），见 requestPinWidget */
  requestPinWidget(size: string): { supported: boolean; requested: boolean };
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

export interface PinWidgetResult {
  /** 当前桌面（launcher）是否支持直接请求添加 */
  supported: boolean;
  /** 是否已成功发起添加请求（supported 且系统接受了请求） */
  requested: boolean;
}

/**
 * 请求把小组件添加到桌面（系统弹确认框）。原生缺失或异常返回 null，
 * 调用方回退为「长按桌面 → 小组件」引导文案。
 */
export function requestPinWidget(size: "2x2" | "4x2"): PinWidgetResult | null {
  if (!native) return null;
  try {
    const result = native.requestPinWidget(size);
    if (!result) return null;
    return { supported: result.supported === true, requested: result.requested === true };
  } catch {
    return null;
  }
}
