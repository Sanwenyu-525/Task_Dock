//! 跨模块事件总线：把后端 Tauri 事件收敛成类型安全的订阅入口。
//!
//! 约束：
//! - 事件只用于刷新 / 提示，**不用于判断操作是否成功**（成功以命令返回值与批次为准）；
//! - 同一 handler 重复订阅会被去重；页面卸载必须调用返回的清理函数；
//! - 模块级订阅可整体清理，避免热更新或路由切换后残留监听。

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

interface Subscription {
  id: number;
  event: string;
  handler: (payload: unknown) => void;
  unlisten: UnlistenFn | null;
  moduleId: string;
}

let nextId = 1;
const subscriptions = new Map<number, Subscription>();
/** event → 已建立的 Tauri 监听（一个事件只挂一个底层 listener，再分发）。 */
const bridges = new Map<string, UnlistenFn>();

async function ensureBridge(event: string): Promise<void> {
  if (bridges.has(event)) return;
  const unlisten = await listen(event, (message) => {
    for (const sub of subscriptions.values()) {
      if (sub.event !== event) continue;
      try {
        sub.handler(message.payload);
      } catch {
        // 单个订阅者异常不能中断其他模块的刷新。
      }
    }
  });
  bridges.set(event, unlisten);
}

/**
 * 订阅后端事件。返回同步清理函数：即使底层 listener 还在建立，清理后再建立
 * 也会立刻注销，不会留下悬挂订阅。
 */
export function subscribe(
  event: string,
  handler: (payload: unknown) => void,
  moduleId = "unknown",
): () => void {
  const id = nextId++;
  const record: Subscription = { id, event, handler, unlisten: null, moduleId };
  subscriptions.set(id, record);
  void ensureBridge(event).then(
    () => {
      const bridge = bridges.get(event);
      if (!bridge) return;
      record.unlisten = bridge;
    },
    () => {
      subscriptions.delete(id);
    },
  );
  return () => {
    subscriptions.delete(id);
    // 底层 listener 由模块整体清理时统一释放；单条退订只移除分发目标。
  };
}

/** 页面 / 模块卸载：注销该模块的全部订阅；无人使用的事件释放底层 listener。 */
export function unsubscribeModule(moduleId: string): void {
  const events = new Set<string>();
  for (const [id, sub] of subscriptions) {
    if (sub.moduleId !== moduleId) continue;
    events.add(sub.event);
    subscriptions.delete(id);
  }
  for (const event of events) {
    const stillUsed = [...subscriptions.values()].some((sub) => sub.event === event);
    if (stillUsed) continue;
    const unlisten = bridges.get(event);
    bridges.delete(event);
    unlisten?.();
  }
}

/** 仅供测试与诊断：当前订阅数量。 */
export function subscriptionCount(): number {
  return subscriptions.size;
}
