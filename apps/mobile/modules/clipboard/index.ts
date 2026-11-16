// 系统剪贴板的 JS 侧封装（本地 Expo module `modules/clipboard`）。
// 原生不可用时（旧构建 / 非 Android）返回明确错误，绝不静默假装复制成功。
import { NativeModule, requireOptionalNativeModule } from "expo-modules-core";

interface ClipboardNativeModule extends NativeModule {
  getTextAsync(): Promise<string | null>;
  setTextAsync(text: string): Promise<boolean>;
}

const native = requireOptionalNativeModule<ClipboardNativeModule>("TaskDockClipboard");

export const clipboardAvailable = native != null;

export async function readClipboardText(): Promise<string | null> {
  if (!native) throw new Error("当前构建没有系统剪贴板模块，请安装最新版 APK");
  return native.getTextAsync();
}

export async function writeClipboardText(text: string): Promise<void> {
  if (!native) throw new Error("当前构建没有系统剪贴板模块，请安装最新版 APK");
  const ok = await native.setTextAsync(text);
  if (!ok) throw new Error("系统剪贴板拒绝了这次写入");
}
