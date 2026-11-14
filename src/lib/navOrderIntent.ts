//! 导航排序的**乐观意图层**：一次移动立即被所有导航消费者看到。
//!
//! 为什么需要它：排序草稿如果只存在设置组件的局部 state，设置列表会立刻变化，
//! 而侧边栏 / 胶囊 / 帮助页读的是已提交配置，两者相差「合并窗口 + 数据库写入」
//! 几十到几百毫秒，看起来像排序没生效。这里把「尚未落库的顺序意图」放到模块级
//! 共享层，任何消费者都读同一份有效顺序。
//!
//! 边界（刻意约束，避免变成第二份配置）：
//! - 事实源仍然是 SQLite `navigation_layout`；意图只在写入完成前存在，
//!   写入成功即清除，界面随之回到事实源；
//! - 意图只表达**顺序**，不表达显隐：应用时按已提交集合过滤，隐藏的入口不会
//!   因为意图里还有它而复活；
//! - 每个界面（left / capsule）各自一份，互不影响；
//! - 意图带单调递增序号：写入失败/成功只清除「仍然是当前序号」的意图，
//!   过期响应不能撤销更新的操作。
//!
//! 不使用 zustand：这里没有需要持久化或调试的长期状态，`useSyncExternalStore`
//! 订阅一个版本号即可，且能保证所有消费者在同一次 React 更新里看到同一顺序。

import { useSyncExternalStore } from "react";
import { insertEntryByDefaultOrder, normalizeNavigationLayout, type NavLayoutConfig } from "./navVisibility";
import type { NavSurface } from "./navigationRegistry";

export interface NavOrderIntent {
  /** 单调递增序号：用于判定「这个意图是否仍然是最新意图」。 */
  seq: number;
  /** 意图中的可见入口顺序（应用时按已提交集合过滤）。 */
  ids: string[];
}

const intents: Record<NavSurface, NavOrderIntent | null> = { left: null, capsule: null };
const listeners = new Set<() => void>();
let version = 0;
let seqCounter = 0;

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeNavOrderIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 供 `useSyncExternalStore` 使用的稳定快照：只有发布/清除时递增。 */
export function readNavOrderIntentVersion(): number {
  return version;
}

export function readNavOrderIntent(surface: NavSurface): NavOrderIntent | null {
  return intents[surface];
}

export function hasNavOrderIntent(): boolean {
  return intents.left !== null || intents.capsule !== null;
}

/** 发布一条新的顺序意图，返回其序号（写入收尾时用它判定是否过期）。 */
export function publishNavOrderIntent(surface: NavSurface, ids: readonly string[]): number {
  seqCounter += 1;
  intents[surface] = { seq: seqCounter, ids: [...ids] };
  notify();
  return seqCounter;
}

/**
 * 按序号清除意图：只有「仍然是当前序号」才清，返回是否真的清除。
 *
 * - 写入成功：清掉自己的意图，界面无缝落到已提交值；
 * - 写入失败：清掉后所有消费者一起回滚到已提交值（失败可见、不留假成功）；
 * - 序号已过期（期间又移动过）：不清，更新的意图仍然有效。
 */
export function clearNavOrderIntent(surface: NavSurface, seq: number): boolean {
  const current = intents[surface];
  if (!current || current.seq !== seq) return false;
  intents[surface] = null;
  notify();
  return true;
}

/** 无条件丢弃（恢复默认等整份覆盖操作），返回被丢弃的意图供调用方判定。 */
export function dropNavOrderIntent(surface: NavSurface): NavOrderIntent | null {
  const current = intents[surface];
  if (!current) return null;
  intents[surface] = null;
  notify();
  return current;
}

/** 测试用：清空全部意图与订阅。序号保持单调递增（不回退）。 */
export function resetNavOrderIntents(): void {
  intents.left = null;
  intents.capsule = null;
  listeners.clear();
  // `seqCounter` 刻意不回退：过期写入的收尾回调可能晚于用例切换到达，
  // 若序号被重置，它会误清掉下一例新发布的意图（生产语义同样依赖单调序号）。
  if (version !== 0) version += 1;
}

/**
 * 把意图顺序套到已提交的可见集合上（纯函数）。
 *
 * 只改顺序，不改显隐：
 * - 意图里已不在提交集合中的 ID（期间被隐藏）丢弃；
 * - 提交集合里但意图里没有的 ID（期间被重新显示）按默认顺序插回，
 *   不打断用户已有的相对顺序。
 */
export function applyNavOrderIntent(
  committed: readonly string[],
  intent: readonly string[],
  surface: NavSurface,
): string[] {
  const present = new Set(committed);
  let next = intent.filter((id) => present.has(id));
  for (const id of committed) {
    if (!next.includes(id)) next = insertEntryByDefaultOrder(next, id, surface);
  }
  return next;
}

/**
 * 已提交布局 + 全部意图 → 有效布局。
 * 末尾再走一次归一化，收紧排序不变量（锁定入口末尾、胶囊状态球端头、去重），
 * 它不会把意图里已失效的 ID 复活（输入集合与提交集合一致）。
 */
export function applyNavOrderIntents(config: NavLayoutConfig): NavLayoutConfig {
  if (!hasNavOrderIntent()) return config;
  const left = intents.left;
  const capsule = intents.capsule;
  return normalizeNavigationLayout({
    ...config,
    left: left ? applyNavOrderIntent(config.left, left.ids, "left") : config.left,
    capsule: capsule ? applyNavOrderIntent(config.capsule, capsule.ids, "capsule") : config.capsule,
  }).config;
}

/** React 侧订阅：返回版本号，任意意图变化都会触发订阅者重渲染。 */
export function useNavOrderIntentVersion(): number {
  return useSyncExternalStore(
    subscribeNavOrderIntent,
    readNavOrderIntentVersion,
    readNavOrderIntentVersion,
  );
}
