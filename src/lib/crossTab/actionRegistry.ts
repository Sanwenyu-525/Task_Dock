//! 全局动作注册表：模块把「能做什么」注册进来，菜单按当前内容动态筛选。
//!
//! 禁止把菜单项硬编码到某个页面：页面只调用 `resolveAvailableActions`，
//! 由动作定义声明支持的类型 / 来源 / 是否需要目标。

import type { ActionDefinition, ActionPayload, ActionResult, TransferItem, TransferContext } from "./types";

const actions = new Map<string, ActionDefinition>();

export function registerAction(action: ActionDefinition): void {
  if (actions.has(action.actionId)) {
    throw new Error(`动作已注册：${action.actionId}`);
  }
  actions.set(action.actionId, action);
}

export function unregisterAction(actionId: string): void {
  actions.delete(actionId);
}

export function getAction(actionId: string): ActionDefinition | undefined {
  return actions.get(actionId);
}

function matches(list: string[], value: string): boolean {
  return list.length === 0 || list.includes(value);
}

export function canExecute(
  actionId: string,
  items: TransferItem[],
  _context: TransferContext,
): boolean {
  const action = actions.get(actionId);
  if (!action || items.length === 0) return false;
  return items.every(
    (item) =>
      matches(action.supportedItemTypes, item.itemType) &&
      matches(action.sourceModules, item.sourceModule),
  ) && (action.targetModules.length === 0 || action.targetModules.includes(_context.module));
}

/** 当前内容可用的动作（按注册顺序）。 */
export function resolveAvailableActions(
  items: TransferItem[],
  _context: TransferContext,
): ActionDefinition[] {
  if (items.length === 0) return [];
  return [...actions.values()].filter((action) => {
    const typeOk = items.every((item) => matches(action.supportedItemTypes, item.itemType));
    const sourceOk = items.every((item) => matches(action.sourceModules, item.sourceModule));
    return typeOk && sourceOk;
  });
}

export async function executeAction(
  actionId: string,
  payload: ActionPayload,
): Promise<ActionResult> {
  const action = actions.get(actionId);
  if (!action) {
    return { ok: false, message: `未注册的动作：${actionId}` };
  }
  if (!canExecute(actionId, payload.items, payload.context)) {
    return { ok: false, message: "当前内容或页面不支持该操作" };
  }
  if (action.requiresTarget && !payload.target?.ref) {
    return { ok: false, message: "请先选择目标" };
  }
  return action.run(payload);
}

/** 仅供测试：清空注册表。 */
export function clearActionsForTests(): void {
  actions.clear();
}
