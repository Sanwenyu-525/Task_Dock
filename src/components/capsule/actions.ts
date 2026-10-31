//! 胶囊内的跨面板动作：跳出胶囊、进入完整窗口。
//!
//! 「不重复实现主窗口功能」的落点：面板只做高频轻操作，重活一律交给既有
//! 主窗口（任务页 / Agent 页 / 剪贴板 / 应用管理），这里只负责切标签 + 解除吸附。

import { applyMode } from "../../lib/bridge";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useUiStore, type Tab } from "../../store/useUiStore";

/**
 * 打开完整窗口并定位到指定标签。
 * 解除吸附时把目标模式一起传给引擎，避免"先恢复旧模式再切新模式"的两次缩放。
 */
export function openFullApp(tab: Tab): void {
  useUiStore.getState().setTab(tab);
  const undock = useEdgeSnapStore.getState().undock;
  if (undock) {
    undock("full");
  } else {
    void applyMode("full");
  }
}
