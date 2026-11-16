//! 剪贴板视图密度（舒适卡片 / 紧凑卡片 / 列表）。
//!
//! 密度只影响**呈现**，与筛选、排序、多选、监听生命周期完全解耦：
//! - 切换密度不重置筛选、不清空多选、不重新拉取数据（列表数据不依赖密度）；
//! - 选择持久化在 localStorage，与 WorkspaceSplit 的布局记忆同一套命名空间；
//! - 读取失败（隐私模式/配额）回退到舒适模式，不阻断页面。

import { useEffect, useState } from "react";

export type ClipboardDensity = "comfort" | "compact" | "list";

export const CLIPBOARD_DENSITY_STORAGE_KEY = "taskdock.clipboard.density";

export const CLIPBOARD_DENSITY_OPTIONS: readonly {
  value: ClipboardDensity;
  label: string;
  hint: string;
}[] = [
  { value: "comfort", label: "舒适", hint: "大图预览与更多正文，日常浏览" },
  { value: "compact", label: "紧凑", hint: "同屏更多条目，快速查找" },
  { value: "list", label: "列表", hint: "单列密集行，适合文字与文件" },
];

export function isClipboardDensity(value: unknown): value is ClipboardDensity {
  return value === "comfort" || value === "compact" || value === "list";
}

export function readClipboardDensity(): ClipboardDensity {
  if (typeof window === "undefined") return "comfort";
  try {
    const raw = window.localStorage.getItem(CLIPBOARD_DENSITY_STORAGE_KEY);
    return isClipboardDensity(raw) ? raw : "comfort";
  } catch {
    return "comfort";
  }
}

export function writeClipboardDensity(density: ClipboardDensity): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CLIPBOARD_DENSITY_STORAGE_KEY, density);
  } catch {
    // 记忆失败只影响下次打开，不影响本次使用。
  }
}

/** 非 Store 场景（独立预览/测试）的持久化密度读取。 */
export function useClipboardDensity(): [ClipboardDensity, (next: ClipboardDensity) => void] {
  const [density, setDensity] = useState<ClipboardDensity>(readClipboardDensity);
  useEffect(() => {
    writeClipboardDensity(density);
  }, [density]);
  return [density, setDensity];
}
