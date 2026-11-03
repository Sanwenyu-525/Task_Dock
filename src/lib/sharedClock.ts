//! 页面级共享时钟：整个应用同一时刻只有一条 1s setInterval。
//!
//! 智能日程提醒 2.0 的倒计时展示约定：
//! - 前端只保存绝对时间（remind_at），每秒用「now」重新换算剩余时间；
//! - 严禁每张倒计时卡片各开一个 setInterval、严禁把剩余秒数写库或长缓存；
//! - 首个订阅者启动计时器，最后一个取消订阅时释放（无悬挂定时器）。
//!
//! 实现：模块级订阅集合 + `useSyncExternalStore` 快照（ms 整数，每秒变化一次）。

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let snapshot = Date.now();

function ensureRunning() {
  if (timer !== null) return;
  timer = setInterval(() => {
    snapshot = Date.now();
    for (const fn of listeners) fn();
  }, 1000);
}

function maybeStop() {
  if (listeners.size > 0 || timer === null) return;
  clearInterval(timer);
  timer = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureRunning();
  return () => {
    listeners.delete(listener);
    maybeStop();
  };
}

function getSnapshot(): number {
  return snapshot;
}

/** 服务端渲染兜底（本项目无 SSR，恒走客户端值）。 */
function getServerSnapshot(): number {
  return 0;
}

/**
 * 订阅共享时钟：返回当前 epoch ms（每秒更新一次）。
 * 组件卸载自动退订；全部组件卸载后计时器释放。
 */
export function useSharedClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 仅供测试：当前是否仍有计时器在跑。 */
export function clockRunning(): boolean {
  return timer !== null;
}

/** 仅供测试：重置快照基准（避免跨用例的模块级残留影响断言）。 */
export function resetSharedClockForTest(): void {
  snapshot = Date.now();
}
