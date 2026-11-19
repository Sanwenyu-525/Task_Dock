//! 跨模块事件总线：把后端 Tauri 事件收敛成类型安全的订阅入口。
//!
//! 约束：
//! - 事件只用于刷新 / 提示，**不用于判断操作是否成功**（成功以命令返回值与批次为准）；
//! - 同一事件只有一个底层 listener，订阅者只是分发目标；
//! - 同一 handler 重复订阅会被去重（返回同一个清理函数）；
//! - 初始化中的 listener Promise 会被记录：并发订阅不会建立第二个 listener；
//! - 初始化完成前退订 → 建立完成后立刻注销，不留悬挂监听；
//! - 模块卸载释放该模块全部订阅，无人使用的事件释放底层 listener；
//! - 单个 handler 抛错不能中断其他模块的刷新。

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const TRANSFER_EVENTS = {
  batchChanged: "transfer:batch-changed",
  contextChanged: "transfer:context-changed",
  jobProgress: "recycle:job-progress",
} as const;

export type TransferEventName = (typeof TRANSFER_EVENTS)[keyof typeof TRANSFER_EVENTS];

/** 后端批次事件载荷。 */
export interface BatchChangedPayload {
  batchId: string;
  status: string;
  total: number;
  ok: number;
  failed: number;
  skipped: number;
}

type Handler = (payload: unknown) => void;

interface Subscription {
  id: number;
  event: string;
  handler: Handler;
  moduleId: string;
  /** 去重键：event + moduleId + handler 身份。 */
  key: string;
}

interface Bridge {
  /** 初始化中的 listener；并发订阅必须复用同一个 Promise。 */
  promise: Promise<UnlistenFn | null>;
  unlisten: UnlistenFn | null;
  /** 建立期间已被要求释放：完成后立即注销。 */
  disposeRequested: boolean;
}

let nextId = 1;
const subscriptions = new Map<number, Subscription>();
/** 去重索引：同一 handler 在同一模块同一事件上只保留一个订阅。 */
const byKey = new Map<string, number>();
const bridges = new Map<string, Bridge>();
/** 函数身份（同一函数引用复用同一 id）。 */
const handlerIds = new WeakMap<Handler, number>();
let nextHandlerId = 1;

function handlerIdOf(handler: Handler): number {
  const existing = handlerIds.get(handler);
  if (existing !== undefined) return existing;
  const id = nextHandlerId++;
  handlerIds.set(handler, id);
  return id;
}

function dispatch(event: string, payload: unknown): void {
  // 快照：handler 内部退订不应影响本轮分发。
  for (const sub of [...subscriptions.values()]) {
    if (sub.event !== event) continue;
    try {
      sub.handler(payload);
    } catch {
      // 单个订阅者异常不能中断其他模块的刷新。
    }
  }
}

function ensureBridge(event: string): Promise<UnlistenFn | null> {
  const existing = bridges.get(event);
  if (existing) return existing.promise;

  const bridge: Bridge = {
    promise: Promise.resolve(null),
    unlisten: null,
    disposeRequested: false,
  };
  bridge.promise = (async () => {
    try {
      const unlisten = await listen(event, (message) => dispatch(event, message.payload));
      if (bridge.disposeRequested) {
        // 建立期间已无人需要：立刻注销，避免悬挂监听。
        unlisten();
        return null;
      }
      bridge.unlisten = unlisten;
      return unlisten;
    } catch (error) {
      // listen 失败：清掉桥接记录，后续订阅可重试；本次订阅保留（事件来了也没有分发，
      // 但下一次 subscribe 会重新建立底层监听）。
      bridges.delete(event);
      throw error;
    }
  })();
  bridges.set(event, bridge);
  return bridge.promise;
}

function releaseBridge(event: string): void {
  const bridge = bridges.get(event);
  if (!bridge) return;
  if (bridge.unlisten) {
    bridge.unlisten();
    bridges.delete(event);
    return;
  }
  // 还在初始化：标记释放，Promise 完成后自行注销。
  bridge.disposeRequested = true;
  bridges.delete(event);
}

/**
 * 订阅后端事件。返回同步清理函数：即使底层 listener 还在建立，清理后也不会留下
 * 悬挂订阅；同一 handler 重复订阅返回同一个清理函数（幂等）。
 */
export function subscribe(event: string, handler: Handler, moduleId = "unknown"): () => void {
  const key = `${event}\u0001${moduleId}\u0001${handlerIdOf(handler)}`;
  const existingId = byKey.get(key);
  if (existingId !== undefined && subscriptions.has(existingId)) {
    return () => unsubscribe(existingId);
  }

  const id = nextId++;
  subscriptions.set(id, { id, event, handler, moduleId, key });
  byKey.set(key, id);
  void ensureBridge(event).catch(() => {
    // 建链失败不抛出到调用方：页面渲染不能因为事件通道暂时不可用而崩溃。
  });
  return () => unsubscribe(id);
}

function unsubscribe(id: number): void {
  const sub = subscriptions.get(id);
  if (!sub) return;
  subscriptions.delete(id);
  if (byKey.get(sub.key) === id) byKey.delete(sub.key);
  const stillUsed = [...subscriptions.values()].some((entry) => entry.event === sub.event);
  if (!stillUsed) releaseBridge(sub.event);
}

/** 页面 / 模块卸载：注销该模块的全部订阅；无人使用的事件释放底层 listener。 */
export function unsubscribeModule(moduleId: string): void {
  const events = new Set<string>();
  for (const [id, sub] of [...subscriptions]) {
    if (sub.moduleId !== moduleId) continue;
    events.add(sub.event);
    subscriptions.delete(id);
    if (byKey.get(sub.key) === id) byKey.delete(sub.key);
  }
  for (const event of events) {
    const stillUsed = [...subscriptions.values()].some((sub) => sub.event === event);
    if (!stillUsed) releaseBridge(event);
  }
}

/** 仅供测试与诊断：当前订阅数量。 */
export function subscriptionCount(): number {
  return subscriptions.size;
}

/** 仅供测试与诊断：已建立的底层 listener 数量。 */
export function bridgeCount(): number {
  return bridges.size;
}

/** 仅供测试与诊断：指定事件是否仍在初始化中。 */
export function hasPendingBridge(event: string): boolean {
  const bridge = bridges.get(event);
  return Boolean(bridge && !bridge.unlisten && !bridge.disposeRequested);
}

/** 仅供测试：清空全部订阅与监听。 */
export function resetEventBusForTests(): void {
  for (const bridge of bridges.values()) {
    if (bridge.unlisten) bridge.unlisten();
    else bridge.disposeRequested = true;
  }
  bridges.clear();
  subscriptions.clear();
  byKey.clear();
}
