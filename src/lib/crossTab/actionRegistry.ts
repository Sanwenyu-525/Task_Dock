//! 全局动作注册表：模块把「能做什么」注册进来，菜单按当前内容动态筛选。
//!
//! 禁止把菜单项硬编码到某个页面：页面只调用 `resolveAvailableActions`，
//! 由动作定义声明支持的类型 / 来源 / 目标 / 是否需要确认。
//!
//! 可用性只有一份实现（[`evaluateAction`]）：菜单显示、`canExecute`、`executeAction`
//! 三处共用同一规则，不会出现「菜单里能点、点了说不可用」。

import type {
  ActionDefinition,
  ActionPayload,
  ActionResult,
  TransferContext,
  TransferItem,
  TransferTarget,
} from "./types";

const actions = new Map<string, ActionDefinition>();

export interface ActionAvailability {
  available: boolean;
  /** 不可用原因（中文，可直接展示）。 */
  reason: string;
}

function matches(list: string[], value: string): boolean {
  return list.length === 0 || list.includes(value);
}

/**
 * 唯一可用性判定。
 *
 * - `supportedItemTypes`：空 = 不限；否则每一项都必须支持（混合选择不能执行只支持文本的动作）。
 * - `sourceModules`：空 = 不限。
 * - `targetModules`：空 = 不限制目标；非空时若已给出目标，目标模块必须在列表内。
 * - `requiresTarget`：必须给出带 `ref` 的目标。
 */
export function evaluateAction(
  action: ActionDefinition | undefined,
  items: TransferItem[],
  context: TransferContext,
  target?: TransferTarget,
): ActionAvailability {
  if (!action) return { available: false, reason: "动作未注册" };
  if (items.length === 0) return { available: false, reason: "请先选择内容" };
  for (const item of items) {
    if (!matches(action.supportedItemTypes, item.itemType)) {
      return { available: false, reason: `不支持的内容类型：${item.itemType}` };
    }
    if (!matches(action.sourceModules, item.sourceModule)) {
      return { available: false, reason: `不支持的内容来源：${item.sourceModule}` };
    }
  }
  const hasTarget = Boolean(target?.ref && target.ref.trim());
  if (action.requiresTarget && !hasTarget) {
    return { available: false, reason: "请先选择目标" };
  }
  if (action.targetModules.length > 0 && hasTarget) {
    if (!action.targetModules.includes(target?.module ?? context.module)) {
      return { available: false, reason: `当前页面不能作为目标：${target?.module ?? context.module}` };
    }
  }
  return { available: true, reason: "" };
}

export function registerAction(action: ActionDefinition): void {
  if (actions.has(action.actionId)) {
    throw new Error(`动作已注册：${action.actionId}`);
  }
  actions.set(action.actionId, action);
}

/** 幂等注册：同一 id 重复注册视为已安装（多窗口 / 热更新重复初始化）。 */
export function ensureAction(action: ActionDefinition): void {
  if (actions.has(action.actionId)) return;
  actions.set(action.actionId, action);
}

export function unregisterAction(actionId: string): void {
  actions.delete(actionId);
}

export function getAction(actionId: string): ActionDefinition | undefined {
  return actions.get(actionId);
}

export function canExecute(
  actionId: string,
  items: TransferItem[],
  context: TransferContext,
  target?: TransferTarget,
): boolean {
  return evaluateAction(actions.get(actionId), items, context, target).available;
}

/** 当前内容可用的动作（按注册顺序）。 */
export function resolveAvailableActions(
  items: TransferItem[],
  context: TransferContext,
  target?: TransferTarget,
): ActionDefinition[] {
  if (items.length === 0) return [];
  return [...actions.values()].filter(
    (action) => evaluateAction(action, items, context, target).available,
  );
}

export async function executeAction(
  actionId: string,
  payload: ActionPayload,
  options: { confirmed?: boolean } = {},
): Promise<ActionResult> {
  const action = actions.get(actionId);
  const availability = evaluateAction(action, payload.items, payload.context, payload.target);
  if (!action || !availability.available) {
    return { ok: false, message: availability.reason || `未注册的动作：${actionId}` };
  }
  if (action.confirmationRequired && !options.confirmed) {
    return { ok: false, message: "该操作需要用户确认后才能执行" };
  }
  return action.run(payload);
}

/** 只读快照（诊断/测试用，不允许外部修改注册表）。 */
export function listActions(): ActionDefinition[] {
  return [...actions.values()];
}

/** 仅供测试：清空注册表。 */
export function clearActionsForTests(): void {
  actions.clear();
}
