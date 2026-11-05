//! 胶囊内的跨面板动作：跳出胶囊、进入完整窗口。
//!
//! 「不重复实现主窗口功能」的落点：面板只做高频轻操作，重活一律交给既有
//! 主窗口（任务页 / Agent 页 / 剪贴板 / 应用管理），这里只负责切标签 + 解除吸附。

import { applyMode } from "../../lib/bridge";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useUiStore, type Tab, type TabSwitchResult } from "../../store/useUiStore";

/**
 * 打开完整窗口并定位到指定标签。
 * 解除吸附时把目标模式一起传给引擎，避免"先恢复旧模式再切新模式"的两次缩放。
 *
 * 返回值表示本次导航事务的结果：
 * - switched：已切页并解除吸附，`after` 已执行；
 * - pending：被未保存草稿拦截，`after` 绑定在待确认导航上，确认后才执行；
 * - blocked：保存中等硬拒绝，未切页、不会执行 `after`。
 *
 * `after` 只允许放在导航成功之后执行（包括用户确认离开后的强制导航），
 * 不能先写一次性意图再导航：取消或拒绝时意图会滞留，之后突然弹层。
 */
export function openFullApp(tab: Tab, after?: () => void): TabSwitchResult {
  return useUiStore.getState().setTab(tab, {
    after: () => {
      const undock = useEdgeSnapStore.getState().undock;
      if (undock) {
        undock("full");
      } else {
        void applyMode("full");
      }
      after?.();
    },
  });
}

/**
 * 打开「添加应用」：进入完整窗口的应用中心，并下发一次性添加意图。
 *
 * 胶囊处于 Win32 `SetWindowRgn` 裁剪态，大型选择器若挂在胶囊里会被裁掉；
 * 因此先解除停靠进入完整窗口。意图由 AppsPanel 消费一次即清除：
 * 保存/取消/返回后不会再次自动打开，不把用户弹回设置页。
 * 意图在导航成功后下发，取消/忙碌拦截时不会留下待消费请求。
 */
export function openAppsAdd(): TabSwitchResult {
  return openFullApp("apps", () => useUiStore.getState().requestAppsAdd());
}

/** 打开完整窗口的应用中心（管理已有快捷应用）。 */
export function openAppsManager(): TabSwitchResult {
  return openFullApp("apps");
}
