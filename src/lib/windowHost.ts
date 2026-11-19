//! 窗口宿主角色（U0）：业务页面不能再假设自己运行在「主窗口 + 完整模式」。
//!
//! 三类角色：
//! - `quick`：主窗口（胶囊 / 极简 / 紧凑 / 完整面板），由贴边吸附状态机决定可见性；
//! - `workbench`：唯一大型完整工作台（label = workspace），页面常驻可见；
//! - `auxiliary`：快速捕获 / 通知 / 右键菜单 / 微件等轻量窗口。
//!
//! 为什么需要模块级角色而不是只用 React Context：
//! `useMainUiVisible.ts` 还导出非 React 版本（`isMainUiVisible` / `isFullViewVisible`），
//! store 模块与事件处理器会直接调用它们。角色在窗口启动时一次性确定，运行期不变，
//! 因此模块级只读值是可靠的，也不会制造第二份可变状态。
//!
//! 约束：角色只由各窗口入口在挂载前设置一次；业务组件只读，不得自行改写。

export type WindowHostRole = "quick" | "workbench" | "auxiliary";

import { createContext, useContext } from "react";

/**
 * 页面活跃上下文（主窗口完整面板与工作台共用）：`true` = 当前页面可见，
 * `false` = 已访问但被隐藏（keep 页面保活），`null` = 不在任何页面上（外壳/弹层）。
 *
 * 为什么需要：按需加载后 keep 页面会留在 DOM（`hidden`），`display:none` 的页面
 * 如果仍被判定为「可见」，剪贴板实时订阅、资源轮询等消费者门控就会永远不停。
 * 两个宿主各自为页面提供真实的 active，页面通过既有 `useFullViewVisible()` 消费，
 * 不需要各自改判据，也不产生第二套状态源。
 */
export const WorkbenchPageActiveContext = createContext<boolean | null>(null);

/** 当前页面是否可见；不在页面槽位内返回 null。 */
export function useWorkbenchPageActive(): boolean | null {
  return useContext(WorkbenchPageActiveContext);
}

let role: WindowHostRole = "quick";

/** 窗口入口在 createRoot 之前调用（每窗口一次）。 */
export function setWindowHostRole(next: WindowHostRole): void {
  role = next;
}

export function getWindowHostRole(): WindowHostRole {
  return role;
}

/** 业务页面使用的宿主判据：当前窗口是否是唯一大型完整工作台。 */
export function isWorkbenchHost(): boolean {
  return role === "workbench";
}

/** 仅测试使用：把角色恢复为主窗口，避免测试间互相污染。 */
export function __resetWindowHostForTests(): void {
  role = "quick";
}
