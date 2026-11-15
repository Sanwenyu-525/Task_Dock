// 应用图标长按快捷方式 → 采集中心（Android）。
//
// 模块通过 ShortcutActivity 跳板把动作写入 SharedPreferences，JS 在启动/回到前台时消费。
// 模块缺失（未 prebuild、iOS、单测）时导出 null，调用方按「无快捷入口」降级。
import { NativeModule, requireOptionalNativeModule } from "expo-modules-core";

export type LaunchAction = "capture" | "camera" | "voice" | "task";

export interface PendingLaunchAction {
  action: LaunchAction;
  at: number;
}

declare class LaunchIntentNativeModule extends NativeModule {
  takePendingAction(): PendingLaunchAction | null;
}

const native = requireOptionalNativeModule<LaunchIntentNativeModule>("LaunchIntent");

export const launchIntentAvailable = native != null;

export default native;
