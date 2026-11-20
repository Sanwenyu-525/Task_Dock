// SafeLog 原生模块的 JS 边界（本地 Expo 模块 `modules/logger`）。
//
// 安全边界：页面代码不直接使用本文件，统一走 src/lib/safeLog.ts（脱敏 + 级别过滤 +
// 有界内存缓冲）。原生不可用（旧构建 / 非 Android / 单测）时 requireOptionalNativeModule
// 返回 null，safeLog.ts 按静默降级处理：只写内存缓冲，绝不抛错、绝不导致崩溃。
import { NativeModule, requireOptionalNativeModule } from "expo-modules-core";

export interface TaskDockLoggerNative extends NativeModule {
  /**
   * 入队一条日志：Logcat 立即写、文件异步落盘；调用本身永不抛错。
   * `metadataJson` 为 null 或 JSON 对象字符串（内容已在 JS 侧脱敏）。
   */
  write(level: string, tag: string, message: string, metadataJson: string | null): void;
  /** 有界等待把文件缓冲刷盘；true = 已 flush（或无内容），false = 超时/失败。 */
  flush(): Promise<boolean>;
}

const native = requireOptionalNativeModule<TaskDockLoggerNative>("TaskDockLogger");

export const taskDockLoggerAvailable = native != null;

export default native;
