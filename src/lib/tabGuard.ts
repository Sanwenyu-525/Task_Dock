//! 跨页面（主 Tab）未保存离开保护。
//!
//! 所有页面切换最终都走 `useUiStore.setTab`，因此在 store 入口做一次门禁，
//! 各编辑器只注册「是否脏 / 是否保存中 / 放弃时如何收尾」，不各自复制导航拦截。
//! 注册顺序即优先级：后注册的子编辑器覆盖外层编辑器。

import { useEffect, useRef, useSyncExternalStore } from "react";

export interface TabGuardEntry {
  id: string;
  /** 用于提示文案的编辑器名称（允许随渲染变化） */
  label: () => string;
  isDirty: () => boolean;
  isBusy: () => boolean;
  /** 用户明确放弃修改时执行：关闭编辑器 / 清空草稿 */
  discard: () => void;
}

const guards = new Map<string, TabGuardEntry>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function registerTabGuard(entry: TabGuardEntry): () => void {
  guards.set(entry.id, entry);
  emit();
  return () => {
    if (guards.get(entry.id) === entry) {
      guards.delete(entry.id);
      emit();
    }
  };
}

/** 当前最内层（最后注册）的编辑器守卫。 */
export function activeTabGuard(): TabGuardEntry | null {
  let last: TabGuardEntry | null = null;
  for (const entry of guards.values()) last = entry;
  return last;
}

export function getActiveTabGuardId(): string | null {
  return activeTabGuard()?.id ?? null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 订阅守卫注册表；与 `useUiStore.pendingTab` 配合渲染全局离开确认条。 */
export function useActiveTabGuardId(): string | null {
  return useSyncExternalStore(subscribe, getActiveTabGuardId, getActiveTabGuardId);
}

/**
 * 在编辑器中注册跨 Tab 离开保护。
 *
 * `useEffect` 只在 id 变化时注册一次，脏/保存状态通过 ref 读取最新值，
 * 避免每次输入都重建注册表；卸载即注销，不会留下全局状态。
 */
export function useTabGuard(opts: {
  id: string;
  label: string;
  dirty: boolean;
  busy?: boolean;
  discard: () => void;
}) {
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    return registerTabGuard({
      id: opts.id,
      label: () => latest.current.label,
      isDirty: () => latest.current.dirty,
      isBusy: () => latest.current.busy ?? false,
      discard: () => latest.current.discard(),
    });
  }, [opts.id]);
}
