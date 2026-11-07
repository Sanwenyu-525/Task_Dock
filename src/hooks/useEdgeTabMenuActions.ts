//! 极简标签右键菜单的动作桥（主窗侧）。
//!
//! 菜单窗口只发命令：后端 `context_menu_action` 把 `tab:expand|full|undock`
//! 转发成一次 `edge-tab-action` 事件到主窗，这里把它交给**唯一的**吸附状态机
//! （`useEdgeSnap` 注入到 store 的恢复/形态切换/解除事务）。
//!
//! 为什么不在菜单窗口里做：窗口几何、区域裁剪、持久化都归主窗引擎所有，
//! 菜单窗口再实现一套就会出现两份状态源与竞争（明令禁止）。
//!
//! 生命周期：随组件挂载/卸载成对订阅，不产生悬空监听。

import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";

/** 与 Rust `context_menu::context_menu_action` 的转发事件名一致。 */
export const TAB_MENU_ACTION_EVENT = "edge-tab-action";

/** 执行一条标签菜单动作；返回 false 表示当前没有可用的引擎入口。 */
export function runTabMenuAction(action: string): boolean {
  const s = useEdgeSnapStore.getState();
  switch (action) {
    case "expand":
      if (!s.restoreTab) return false;
      // 与单击同一条事务：恢复轨道 → 展开最近使用的面板
      s.restoreTab({ reveal: true });
      return true;
    case "full":
      if (!s.formSwitch) return false;
      // 本次停靠会话的临时形态切换，不写持久化的默认吸附方式
      s.formSwitch("full");
      return true;
    case "undock":
      if (!s.undock) return false;
      s.undock();
      return true;
    default:
      return false;
  }
}

export function useEdgeTabMenuActions(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<string>(TAB_MENU_ACTION_EVENT, (event) => {
      runTabMenuAction(event.payload);
    })
      .then((fn) => {
        // 订阅兑现前已卸载：立即释放，避免监听器泄漏
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // 事件系统不可用（预览/测试环境）：菜单入口自然失效，不影响标签交互
      });
    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, []);
}
