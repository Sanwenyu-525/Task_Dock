//! 导航排序草稿：拖动/长按期间即时更新界面，持久化按窗口合并。
//!
//! 为什么不直接复用 `moveNavigationEntry`：
//! - 它在每次移动后立刻走一次「读设置 → 改 → 写库」，连续长按会以 120–160ms
//!   的节奏触发高频磁盘写入；
//! - 写入在途期间设置页会整体禁用，长按会被打断。
//!
//! 本 Hook 的分工：
//! - **草稿**：只存在于组件内，`ids` = 草稿 ?? 后端配置，保证每次移动立刻可见；
//! - **合并写入**：最后一次移动后 `COALESCE_MS` 落库，长按过程最长
//!   `MAX_COALESCE_MS` 强制落一次，避免长时间不落盘；
//! - **收尾**：`flush()` 用于切界面/改显隐/恢复默认/卸载前，把草稿同步落库，
//!   这样「顺序」与随后基于同一份配置的其它写入不会互相覆盖；
//! - **失败**：丢弃草稿回到后端真实顺序并上报错误，不留下假成功。
//!
//! 串行化仍由 `persistNavigationLayout` 的写入链保证：草稿写入与其它设置写入
//! 按调用顺序执行，后一次读到的必然是前一次已落库的结果。

import { useCallback, useEffect, useRef, useState } from "react";
import { persistNavigationLayout } from "../lib/navigationLayout";
import { errorMessage } from "../lib/errors";
import { moveEntryInList, moveEntryToIndex } from "../lib/navVisibility";
import type { NavSurface } from "../lib/navigationRegistry";

/** 最后一次移动后等待多久落库（毫秒）。 */
export const NAV_ORDER_COALESCE_MS = 320;

/** 连续操作时最长多久必须落一次库（毫秒）。 */
export const NAV_ORDER_MAX_COALESCE_MS = 1000;

export interface NavOrderDraft {
  /** 当前生效顺序（草稿优先）。 */
  ids: string[];
  /** 存在未落库的本地顺序。 */
  dirty: boolean;
  /** 上移/下移一格；返回 false 表示已到边界（调用方据此停止连续移动）。 */
  move: (id: string, delta: -1 | 1) => boolean;
  /** 拖拽落位到最终数组下标；返回 false 表示顺序未变化。 */
  moveTo: (id: string, toIndex: number) => boolean;
  /** 立即落库（无草稿时仅等待在途写入）。 */
  flush: () => Promise<void>;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function useNavOrderDraft(
  surface: NavSurface,
  committed: readonly string[],
  isFixed: (id: string) => boolean,
  onError: (message: string) => void,
): NavOrderDraft {
  const committedRef = useRef(committed);
  committedRef.current = committed;
  const fixedRef = useRef(isFixed);
  fixedRef.current = isFixed;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const surfaceRef = useRef(surface);

  const [draft, setDraft] = useState<string[] | null>(null);
  const draftRef = useRef<string[] | null>(null);
  const timerRef = useRef<number | null>(null);
  const firstPendingAtRef = useRef<number | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** 把当前草稿写库；无草稿时直接返回。失败回退到后端顺序。 */
  const write = useCallback(async (): Promise<void> => {
    clearTimer();
    firstPendingAtRef.current = null;
    const snapshot = draftRef.current;
    if (!snapshot) {
      if (inflightRef.current) await inflightRef.current;
      return;
    }
    const targetSurface = surfaceRef.current;
    const run = persistNavigationLayout((current) => ({
      ...current,
      [targetSurface]: snapshot,
    }))
      .then(() => {
        // 只有当草稿仍是这一份时才清空：期间若又发生移动，保留更新的草稿。
        if (draftRef.current === snapshot) {
          draftRef.current = null;
          setDraft(null);
        }
      })
      .catch((error: unknown) => {
        if (draftRef.current === snapshot) {
          draftRef.current = null;
          setDraft(null);
        }
        onErrorRef.current(errorMessage(error));
      });
    inflightRef.current = run;
    await run;
    if (inflightRef.current === run) inflightRef.current = null;
  }, [clearTimer]);

  const schedule = useCallback(() => {
    if (typeof window === "undefined") return;
    const now = Date.now();
    if (firstPendingAtRef.current === null) firstPendingAtRef.current = now;
    clearTimer();
    const elapsed = now - firstPendingAtRef.current;
    const delay = Math.max(
      0,
      Math.min(NAV_ORDER_COALESCE_MS, NAV_ORDER_MAX_COALESCE_MS - elapsed),
    );
    timerRef.current = window.setTimeout(() => {
      void write();
    }, delay);
  }, [clearTimer, write]);

  const apply = useCallback(
    (next: string[]): boolean => {
      if (sameOrder(draftRef.current ?? committedRef.current, next)) return false;
      draftRef.current = next;
      setDraft(next);
      schedule();
      return true;
    },
    [schedule],
  );

  const move = useCallback(
    (id: string, delta: -1 | 1) =>
      apply(moveEntryInList(draftRef.current ?? committedRef.current, id, delta, fixedRef.current)),
    [apply],
  );

  const moveTo = useCallback(
    (id: string, toIndex: number) =>
      apply(
        moveEntryToIndex(draftRef.current ?? committedRef.current, id, toIndex, fixedRef.current),
      ),
    [apply],
  );

  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      // 有待发草稿：立即写，不再等合并窗口。
      await write();
      return;
    }
    if (inflightRef.current) await inflightRef.current;
  }, [write]);

  // 切换界面：调用方已 flush；这里兜底丢弃残留草稿，避免把 A 的顺序写进 B。
  useEffect(() => {
    if (surfaceRef.current === surface) return;
    surfaceRef.current = surface;
    clearTimer();
    firstPendingAtRef.current = null;
    if (draftRef.current) {
      draftRef.current = null;
      setDraft(null);
    }
  }, [surface, clearTimer]);

  // 卸载（折叠分组 / 切页）：把最后一笔顺序落库，不丢用户操作。
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const snapshot = draftRef.current;
      draftRef.current = null;
      if (snapshot) {
        void persistNavigationLayout((current) => ({
          ...current,
          [surfaceRef.current]: snapshot,
        })).catch(() => {});
      }
    },
    [],
  );

  const ids = draft ?? (committed as string[]);
  return { ids, dirty: draft !== null, move, moveTo, flush };
}
