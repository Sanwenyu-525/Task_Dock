//! 页面级共享时钟：整个应用同一时刻只有一条 1s setInterval。
//!
//! 智能日程提醒 2.0 的倒计时展示约定：
//! - 前端只保存绝对时间（remind_at），每秒用「now」重新换算剩余时间；
//! - 严禁每张倒计时卡片各开一个 setInterval、严禁把剩余秒数写库或长缓存；
//! - 首个订阅者启动计时器，最后一个取消订阅时释放（无悬挂定时器）。
//!
//! 实现：模块级订阅集合 + `useSyncExternalStore` 快照（ms 整数，每秒变化一次）。

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let snapshot = Date.now();
let visibilityBound = false;

/** 当前 WebView 是否可见（窗口最小化/隐藏到托盘时为 hidden）。 */
function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function notify() {
  for (const fn of listeners) fn();
}

function ensureRunning() {
  if (timer !== null || !documentVisible()) return;
  timer = setInterval(() => {
    snapshot = Date.now();
    notify();
  }, 1000);
}

function maybeStop() {
  if (timer === null) return;
  // 没有消费者，或整个窗口已隐藏：都不该继续每秒唤醒。
  if (listeners.size > 0 && documentVisible()) return;
  clearInterval(timer);
  timer = null;
}

/**
 * 可见性变化：隐藏时停表；恢复时重新对齐并立即通知，避免倒计时滞后。
 * 整个应用只绑定一次 document 监听（模块级，不随消费者增减重复注册）。
 */
function onVisibilityChange() {
  if (documentVisible()) {
    snapshot = Date.now();
    ensureRunning();
    notify();
  } else {
    maybeStop();
  }
}

function subscribe(listener: () => void): () => void {
  if (!visibilityBound && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
    visibilityBound = true;
  }
  // 首个订阅者重新对齐当前时间：计时器停止期间 snapshot 会冻结在上次停表时刻，
  // 若停表较久（面板关闭后重新打开、跨用例），首次渲染会显示滞后的倒计时。
  if (timer === null) snapshot = Date.now();
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
 *
 * @param enabled 页面不可见时传 false：组件仍保持挂载（保活页面不丢状态），
 *   但**不再是时钟消费者**。最后一个可见消费者退出后计时器即释放；
 *   恢复可见时重新订阅并立即对齐当前时间，倒计时不会滞后。
 *   这是真正的消费者计数，不是用 CSS 隐藏定时器。
 */
export function useSharedClock(enabled = true): number {
  const subscribeFor = useCallback(
    (listener: () => void) => (enabled ? subscribe(listener) : () => {}),
    [enabled],
  );
  return useSyncExternalStore(subscribeFor, getSnapshot, getServerSnapshot);
}

/** 仅供测试：当前是否仍有计时器在跑。 */
export function clockRunning(): boolean {
  return timer !== null;
}

/** 仅供测试：重置快照基准（避免跨用例的模块级残留影响断言）。 */
export function resetSharedClockForTest(): void {
  snapshot = Date.now();
}
