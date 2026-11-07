//! Edge Tab 的跨窗口入口（悬停提示 / 右键快捷菜单）。
//!
//! 为什么必须走独立窗口：极简标签的原生可见区只有 10×46（见
//! `lib/capsuleLayout.ts` 与 Rust `capsule_tab_regions`），主窗内的任何浮层
//! 都会被 `SetWindowRgn` 裁成残片。提示用 `tab-hint` 窗口（不抢焦点、点击穿透），
//! 菜单复用既有 `context-menu` 液态玻璃弹窗（tab 变体）。
//!
//! 这里只做薄封装：
//! - 浏览器预览 / 非 Tauri 环境直接跳过，不产生未处理 rejection；
//! - 提示的显示/隐藏做**状态去重**（同一悬停周期里不重复发 IPC）；
//! - 失败静默：提示与菜单都是增强能力，不能反过来影响标签的点击与拖动。

import { isTauri } from "@tauri-apps/api/core";
import { invokeCommand } from "./errors";
import type { SnapEdge } from "./edgeSnap";

/** 悬停提示是否已在屏幕上（仅用于隐藏去重的统计，不再阻断任何一次 hide）。 */
let hintVisible = false;
/** 已受理的提示文案/停靠边：同一次悬停里重复请求不再发 IPC；文案变化必须照发。 */
let hintText: string | null = null;
let hintEdge: SnapEdge | null = null;
/**
 * 悬停会话代次：`show` 的 IPC 往返期间可能已经离开（hide 把标记清掉），
 * 迟到的结果显示不得把标记重新置真，否则下一次悬停会被去重门挡住、静默不弹。
 */
let hintSession = 0;

/** 仅测试用：复位模块级缓存，避免用例之间互相影响。 */
export function resetEdgeTabActionState(): void {
  hintVisible = false;
  hintText = null;
  hintEdge = null;
  hintSession += 1;
}

/**
 * 显示悬停提示：`text` 为空时不显示（未加载状态不得伪装成有状态）。
 *
 * 去重只针对**同一次悬停里的同文案例行调用**（组件重渲染、连续事件）：
 * 文案变化（Agent 状态 running → waiting …）必须重新发请求，由后端推进代次、
 * 前端重新测量，提示条原地更新而不是先隐藏再闪现。
 *
 * 去重标记以后端**真实返回**为准：后端因标签几何缺失等原因没进入显示流程时，
 * 标记保持 false，下一次悬停仍会尝试——不会出现「一次失败后永远不弹」。
 */
export async function showTabHint(edge: SnapEdge, text: string): Promise<boolean> {
  if (!isTauri() || !text) return false;
  if (hintVisible && hintEdge === edge && hintText === text) return true;
  const session = ++hintSession;
  try {
    const accepted = (await invokeCommand<boolean>("show_tab_hint", { edge, text })) === true;
    // 只认本轮会话的结果：期间已经 hide 过就不要复活标记
    if (session === hintSession) {
      hintVisible = accepted;
      hintText = accepted ? text : null;
      hintEdge = accepted ? edge : null;
    }
    return accepted;
  } catch {
    // 提示窗不可用（例如旧后端未注册命令）：保持沉默，标签交互不受影响
    if (session === hintSession) {
      hintVisible = false;
      hintText = null;
      hintEdge = null;
    }
    return false;
  }
}

/**
 * 隐藏悬停提示（幂等）。
 *
 * **不带 `hintVisible` 守卫**：显示标记与原生可见性一旦失步（例如后台隐藏、
 * 重启窗口），带守卫的 hide 会让提示条永久留在屏幕上。hide 本身很轻（一次
 * `hide()`），每次离开/按下/失焦/卸载都发一次是正确性与健壮性的取舍。
 */
export async function hideTabHint(): Promise<void> {
  if (!isTauri()) return;
  hintSession += 1;
  hintVisible = false;
  try {
    await invokeCommand("hide_tab_hint");
  } catch {
    // 窗口已隐藏/不存在：无需反馈
  }
}

/**
 * 在标签旁打开快捷菜单（屏幕定位由后端按当前窗口矩形与显示器工作区计算，
 * 多显示器 / 负坐标 / 不同 DPI 都在原生侧统一处理）。
 */
export async function showTabMenu(edge: SnapEdge): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return (await invokeCommand<boolean>("show_tab_context_menu", { edge })) === true;
  } catch {
    return false;
  }
}
