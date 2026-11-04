//! 全局搜索快捷键：Ctrl+Shift+F（应用内，非系统级常驻热键）。
//!
//! 独立监听器，不改动 useGlobalShortcuts.ts（该文件处于并行修改中）；
//! `useGlobalShortcuts` 对「Shift + 非 KeyC」组合直接 return，不会与本 hook 冲突。
//! 与 Ctrl+Shift+C 同策略：不做输入框 typing 判断（Shift 组合键语义明确），
//! 搜索弹窗打开时再按 = 关闭（toggle）。

import { useEffect } from "react";

import { useGlobalSearchStore } from "../store/useGlobalSearchStore";

export function useGlobalSearchShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || !e.shiftKey) return;
      if (e.code !== "KeyF") return;
      e.preventDefault();
      useGlobalSearchStore.getState().toggleSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
