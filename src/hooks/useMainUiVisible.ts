//! 主界面可见性派生钩子（导航显隐与资源生命周期的「页面活跃状态」层）。
//!
//! 三层语义（见 docs/ARCHITECTURE.md「导航显隐与资源生命周期」）：
//! 1. 导航可见性：入口是否显示在侧栏/胶囊（`navigation_layout`，只影响渲染）；
//! 2. 页面活跃状态：用户当前是否能看到这块 UI —— 本文件提供的两个钩子；
//! 3. 后台业务启用：模块自身的设置开关（如 actions_enabled / clipboard_enabled），
//!    **绝不**由前两者推导，隐藏导航不等于停服务。
//!
//! 实现约束：
//! - 只从既有 store 派生（`useEdgeSnapStore.phase` + `settings.mode`），
//!   不创建第二份状态源、不引入定时器、不注册监听；
//! - `docked-full`（完整面板停靠态）主界面仍然完整可见，视为活跃；
//! - 停靠期 `.dock-app` 是 display:none + inert：React 仍会重渲染隐藏子树，
//!   因此页面级可选刷新/订阅（剪贴板 live、历史事件刷新、倒计时共享时钟、
//!   行动中心计数聚合）应以这两个钩子做消费者门控 —— 隐藏即暂停，
//!   恢复可见时按各自语义补一次刷新。
//!
//! 注意分层：核心后台能力（Agent 快照事件刷新、任务提醒、剪贴板采集、
//! 微件桌面窗口）**不使用**本门控，它们由事件驱动与各自的设置开关管理。

import { useSettingsStore } from "../store/useSettingsStore";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { isCapsuleMode } from "../lib/edgeSnap";
import { resolveWindowMode } from "../lib/windowMode";
import { isWorkbenchHost, useWorkbenchPageActive } from "../lib/windowHost";

/** 非 React 调用方（store 模块 / 事件处理器）：主界面当前是否可见。 */
export function isMainUiVisible(): boolean {
  // 工作台窗口没有贴边吸附/胶囊相位：页面常驻可见，不能用主窗口的相位判据
  // （否则工作台里的页面会误判自己处于「胶囊隐藏」而暂停刷新）。
  if (isWorkbenchHost()) return true;
  return !isCapsuleMode(useEdgeSnapStore.getState().phase);
}

/** React 侧：主界面（`.dock-app`）当前是否可见（停靠胶囊期为 false）。 */
export function useMainUiVisible(): boolean {
  // 两个 store 订阅必须无条件调用（Hooks 规则），再由宿主角色/页面活跃覆盖结果。
  const quickVisible = useEdgeSnapStore((s) => !isCapsuleMode(s.phase));
  const pageActive = useWorkbenchPageActive();
  if (pageActive !== null) return pageActive;
  return isWorkbenchHost() || quickVisible;
}

/**
 * 完整面板（FullView 槽位）当前是否可见：mode=full 且主界面未停靠。
 * FullView 内的页面组件常驻挂载（DeferredView 保活），模式切换/停靠期
 * 变为隐藏态 —— 页面级可选刷新以此为消费者判据。
 *
 * 工作台窗口：完整功能页常驻于唯一大型宿主，页面可见性与主窗口模式无关。
 */
export function useFullViewVisible(): boolean {
  const mode = useSettingsStore((s) => resolveWindowMode(s.settings?.mode));
  const visible = useEdgeSnapStore((s) => mode === "full" && !isCapsuleMode(s.phase));
  const pageActive = useWorkbenchPageActive();
  // 工作台内：只认当前路由是否可见（隐藏页面必须暂停消费者刷新）。
  if (pageActive !== null) return pageActive;
  return isWorkbenchHost() || visible;
}

/**
 * 非 React 调用方（事件处理器 / store 模块）：完整面板当前是否可见。
 *
 * 与 `isMainUiVisible` 的区别：极简/紧凑模式下主界面（标题栏等）仍可见，
 * 但**侧栏与完整面板页面不渲染**。只消费侧栏徽标/完整页面的门控必须用本函数，
 * 否则「非完整模式」会被误判成仍有 UI 消费者（行动中心计数聚合即为此类）。
 * 设置尚未加载时按安全页 `full` 处理（保守放行，不因启动竞态漏刷新）。
 */
export function isFullViewVisible(): boolean {
  if (isWorkbenchHost()) return true;
  if (resolveWindowMode(useSettingsStore.getState().settings?.mode) !== "full") return false;
  return !isCapsuleMode(useEdgeSnapStore.getState().phase);
}
