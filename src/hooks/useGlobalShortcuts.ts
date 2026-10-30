//! 全局快捷键（v0.6）。
//!
//! - Ctrl+1…6：完整模式切换六个侧边栏入口，顺序见 `TAB_ORDER`
//! - Ctrl+K：快速添加任务
//! - Ctrl+Shift+C：完整模式进入剪贴板页面；紧凑 / 极简模式开关临时剪贴板抽屉
//!
//! 抽成独立 Hook 的原因：
//! 1. 入口顺序只有 `TAB_ORDER` 一处定义，导航渲染、快捷键、说明文档共用；
//! 2. 契约可测 —— 快捷键行为需要脱离整套应用单独回归；
//! 3. 与 Escape 解耦 —— 弹层关闭优先级由 `lib/overlayStack.ts` 统一调度，
//!    这里只处理导航类按键，避免"隐藏窗口"和"关闭菜单"互相抢按键。

import { useEffect } from "react";
import { useUiStore, TAB_ORDER } from "../store/useUiStore";
import { useSettingsStore } from "../store/useSettingsStore";

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    Boolean(el.isContentEditable)
  );
}

function isFullMode(): boolean {
  return (useSettingsStore.getState().settings?.mode ?? "full") === "full";
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const ui = useUiStore.getState();

      if (e.shiftKey && e.code === "KeyC") {
        e.preventDefault();
        if (isFullMode()) {
          // 完整模式：剪贴板已是左侧导航的第 4 个入口，直接切页
          ui.setTab("clipboard");
          ui.closeClipboard();
        } else if (ui.clipboardOpen) {
          ui.closeClipboard();
        } else {
          ui.openClipboard();
        }
        return;
      }
      if (e.shiftKey) return;

      const typing = isTypingTarget(e.target);
      if (e.code === "KeyK") {
        // 输入框里保留原生编辑行为，避免抢按键
        if (typing) return;
        e.preventDefault();
        ui.bumpQuickAdd();
        return;
      }
      if (typing) return;

      const match = /^Digit([1-9])$/.exec(e.code);
      if (!match) return;
      const index = Number(match[1]) - 1;
      if (index >= TAB_ORDER.length) return;
      if (!isFullMode()) return;
      e.preventDefault();
      ui.setTab(TAB_ORDER[index]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
