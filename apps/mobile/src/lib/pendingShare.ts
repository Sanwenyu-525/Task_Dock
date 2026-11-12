// 系统分享载荷的内存队列 + 订阅者（模式参考 pendingPairing）。
//
// 为什么在原生之上再包一层：原生侧是单槽（只保留最新一条），JS 侧用有界队列
// 缓冲「屏幕还没挂载就连续到达」的多条分享；同时把事件与拉取两条通道的
// 重复载荷按 offerId 去重。载荷只在内存流转，不落盘、不写日志（正文隐私）。

import ShareIntentModule from "../../modules/share-intent";
import type { ShareIntentPayload } from "../../modules/share-intent";

type Listener = (payload: ShareIntentPayload) => void;

/** 队列上限：连续快速分享时只保留最近几条，最旧的被顶掉（防无界增长） */
const MAX_QUEUE = 5;

let queue: ShareIntentPayload[] = [];
/** 已处理过的最大 offerId：原生 offerId 单调递增，小于等于它的都是重复投递 */
let lastOfferId = 0;
const listeners = new Set<Listener>();

/** 入队一条分享载荷；重复投递返回 false，不重复通知。 */
export function offerShare(payload: ShareIntentPayload): boolean {
  if (!Number.isFinite(payload?.offerId) || payload.offerId <= lastOfferId) return false;
  lastOfferId = payload.offerId;
  queue.push(payload);
  if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
  for (const listener of listeners) listener(payload);
  return true;
}

/** 取走最早的待处理分享（取走后出队）；屏幕挂载时调用。 */
export function consumePendingShare(): ShareIntentPayload | null {
  return queue.shift() ?? null;
}

export function subscribePendingShare(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 订阅原生 onShareReceived 事件（运行中分享的唯一通道），桥接进队列：
 * 事件载荷经 offerShare 去重入队并通知队列订阅者。原生模块缺失时返回空清理函数。
 */
export function subscribeNativeShareEvents(listener: Listener): () => void {
  if (!ShareIntentModule) return () => undefined;
  const subscription = ShareIntentModule.addListener("onShareReceived", (payload) => {
    listener(payload);
  });
  return () => subscription.remove();
}

/**
 * 冷启动拉取：从原生待处理槽取初始分享并入队（原生模块缺失时静默跳过）。
 * 返回是否拉到了新载荷（调用方据此导航到分享页）。
 */
export function pullInitialShare(): boolean {
  if (!ShareIntentModule) return false;
  try {
    const payload = ShareIntentModule.takePendingShare();
    if (!payload) return false;
    return offerShare(payload);
  } catch {
    return false;
  }
}

/** 用户取消/返回：清空 JS 队列与原生待处理槽，不残留待处理载荷。 */
export function discardPendingShare(): void {
  queue = [];
  try {
    ShareIntentModule?.clearPendingShare();
  } catch {
    // 原生侧异常时队列已清，无需处理
  }
}
