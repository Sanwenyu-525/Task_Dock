// 系统栏空隙（insets）计算。
//
// 为什么不用 react-native-safe-area-context：该库的 codegen 产物路径在 Windows 上会超过
// 260 字符，导致 ninja 无法创建对象文件（本仓库路径 D:\Develop\task_dock\apps\mobile 已复现）。
// Android 16 起 edge-to-edge 强制生效，这里改为纯 JS 计算：
// - 顶部用 StatusBar.currentHeight（安卓可靠返回状态栏高度）；
// - 底部用屏幕高度与窗口高度之差，扣掉顶部后即导航栏/手势条高度。
import { useEffect, useState } from "react";
import { Dimensions, Platform, StatusBar } from "react-native";

export interface Insets {
  top: number;
  bottom: number;
}

function compute(): Insets {
  const top = Platform.OS === "android" ? (StatusBar.currentHeight ?? 24) : 0;
  const screen = Dimensions.get("screen");
  const win = Dimensions.get("window");
  const raw = Math.round(screen.height - win.height - top);
  // 某些 ROM 在 edge-to-edge 下 screen 与 window 相等，此时给一个保守的底部留白
  const bottom = raw > 0 ? Math.min(raw, 48) : 8;
  return { top, bottom };
}

export function useWindowInsets(): Insets {
  const [insets, setInsets] = useState<Insets>(compute);

  useEffect(() => {
    const sub = Dimensions.addEventListener("change", () => setInsets(compute()));
    return () => sub.remove();
  }, []);

  return insets;
}
