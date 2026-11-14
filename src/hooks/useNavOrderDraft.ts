//! 导航排序草稿：拖动/长按期间即时更新界面，持久化按窗口合并。
//!
//! 为什么不直接复用 `moveNavigationEntry`：
//! - 它在每次移动后立刻走一次「读设置 → 改 → 写库」，连续长按会以 120–160ms
//!   的节奏触发高频磁盘写入；
//! - 写入在途期间设置页会整体禁用，长按会被打断。
//!
//! 分工：
//! - **意图（乐观层）**：顺序立刻发布到 `navOrderIntent` 的模块级共享层，
//!   设置列表、侧边栏、胶囊、帮助页在同一次 React 更新里看到同一顺序，
//!   不必等 SQLite 写入完成；
//! - **合并写入**：最后一次移动后 `COALESCE_MS` 落库，连续操作最长
//!   `MAX_COALESCE_MS` 强制落一次，避免长时间不落盘；
//! - **序号**：每次移动发布新序号。写入收尾只处理「仍然是当前序号」的意图 ——
//!   过期响应不会把界面回退到更早的顺序，也不会错误地覆盖更新的操作；
//! - **失败语义**：每次写入都返回明确结果（成功 / 被更新意图取代 / 当前意图失败）。
//!   `flush()` 既检查自己发起的写入，也检查**已经在途**的写入结果：当前有效意图
//!   写失败即 reject，所有消费者一起回滚到已提交顺序（不留假成功，调用方也不会
//!   继续执行依赖本次排序的操作）；过期意图的失败只代表「那一笔没落库」，不算
//!   本次成功也不算终止错误，`flush()` 必须继续保存仍然有效的意图；
//!   定时器路径（无人 await）只就地提示，不产生未处理 rejection；
//! - **收敛**：`flush()` 只在目标界面**没有待保存意图且没有在途写入**时 resolve。
//!   轮次上限只是异常保护：真的是「排序还在持续变化」时显式失败，绝不静默返回
//!   成功（调用方在这之前会用 busy / 切换事务锁封住新的排序输入）；
//! - **收尾**：切界面/改显隐/恢复默认/卸载前处理残留意图，避免「顺序」与其它
//!   写入互相覆盖。
//!
//! 串行化仍由 `persistNavigationLayout` 的写入链保证：草稿写入与其它设置写入
//! 按调用顺序执行，后一次读到的必然是前一次已落库的结果。

import { useCallback, useEffect, useRef } from "react";
import { persistNavigationLayout } from "../lib/navigationLayout";
import { errorMessage } from "../lib/errors";
import { moveEntryInList, moveEntryToIndex } from "../lib/navVisibility";
import type { NavSurface } from "../lib/navigationRegistry";
import {
  clearNavOrderIntent,
  dropNavOrderIntent,
  publishNavOrderIntent,
  readNavOrderIntent,
  useNavOrderIntentVersion,
  type NavOrderIntent,
} from "../lib/navOrderIntent";

/** 最后一次移动后等待多久落库（毫秒）。 */
export const NAV_ORDER_COALESCE_MS = 320;

/** 连续操作时最长多久必须落一次库（毫秒）。 */
export const NAV_ORDER_MAX_COALESCE_MS = 1000;

/**
 * `flush()` 的轮次上限：只作异常保护（正常 1–2 轮）。
 *
 * 达到上限说明调用方没有封住新的排序输入、意图仍在持续变化 —— 这种情况下
 * 宁可显式失败，也不能像旧实现那样「写完 4 轮就当保存完成」把最后的排序丢掉。
 */
const NAV_ORDER_FLUSH_MAX_ROUNDS = 8;

/** 单次写入的结果：调用方据此区分「已落库」「被更新意图取代」「当前意图失败」。 */
type NavWriteResult =
  | { status: "success"; seq: number }
  | { status: "superseded"; seq: number }
  | { status: "failed"; seq: number; error: Error };

/** `flush()` 未能在轮次上限内收敛时的错误信息（持续输入，而不是数据已保存）。 */
const FLUSH_UNSETTLED_MESSAGE = "导航排序仍在持续变化，未能在限定轮次内完成保存，请重试";

export interface NavOrderDraft {
  /** 当前生效顺序（未落库意图优先，否则为已提交顺序）。 */
  ids: string[];
  /** 存在未落库的本地顺序。 */
  dirty: boolean;
  /** 上移/下移一格；返回 false 表示已到边界（调用方据此停止连续移动）。 */
  move: (id: string, delta: -1 | 1) => boolean;
  /** 拖拽落位到最终数组下标；返回 false 表示顺序未变化。 */
  moveTo: (id: string, toIndex: number) => boolean;
  /**
   * 立即落库。**成功 resolve、失败 reject**（调用方据此中止依赖本次排序的操作）。
   * 没有待保存顺序时只等待在途写入。
   */
  flush: () => Promise<void>;
  /** 丢弃未落库意图（恢复默认等整份覆盖操作；随后写入不再受旧顺序影响）。 */
  discard: () => void;
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

  // 订阅共享意图版本：发布/清除后本组件与所有导航消费者一起重渲染。
  useNavOrderIntentVersion();

  const timerRef = useRef<number | null>(null);
  const firstPendingAtRef = useRef<number | null>(null);
  const inflightRef = useRef<Promise<NavWriteResult> | null>(null);
  // 卸载后不再向已卸载组件写状态：写入收尾仍会清除意图/回滚，只是不提示 UI
  // （卸载路径另有可追踪记录，见下方清理副作用）。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * 写一笔意图，返回明确结果。
   *
   * - `success`：已落库且没有更新的意图（界面无缝落回事实源）；
   * - `superseded`：写入完成（或失败）时该意图已被更新意图/整份覆盖操作取代。
   *   失败也不会回滚更新的意图 —— 但它**不等于本次操作成功**：`flush()` 会继续
   *   保存仍然有效的那份意图，只有收敛后才 resolve；
   * - `failed`：该意图仍是当前意图且写入失败 —— 已回滚并就地提示，调用方必须
   *   中止依赖本次排序的操作。
   */
  const writeOnce = useCallback(
    async (targetSurface: NavSurface, intent: NavOrderIntent): Promise<NavWriteResult> => {
      try {
        await persistNavigationLayout((current) => ({
          ...current,
          [targetSurface]: intent.ids,
        }));
        const stillCurrent = clearNavOrderIntent(targetSurface, intent.seq);
        return { status: stillCurrent ? "success" : "superseded", seq: intent.seq };
      } catch (error) {
        const message = errorMessage(error);
        // 按序号清除：只有「仍然是当前意图」才需要回滚 + 提示；期间又移动过
        // （更新意图）或整份覆盖操作已丢弃它时，这次失败对最终状态没有影响，
        // 报错只会干扰用户。
        const stillCurrent = clearNavOrderIntent(targetSurface, intent.seq);
        if (!stillCurrent) return { status: "superseded", seq: intent.seq };
        if (mountedRef.current) onErrorRef.current(message);
        return { status: "failed", seq: intent.seq, error: new Error(message) };
      }
    },
    [],
  );

  const startWrite = useCallback(
    (targetSurface: NavSurface, intent: NavOrderIntent): Promise<NavWriteResult> => {
      const pending = writeOnce(targetSurface, intent);
      inflightRef.current = pending;
      // writeOnce 内部已捕获失败、不会 reject；这里两个回调都挂同一个收尾，
      // 避免任何意外 rejection 变成未处理 Promise。
      const settle = () => {
        if (inflightRef.current === pending) inflightRef.current = null;
      };
      void pending.then(settle, settle);
      return pending;
    },
    [writeOnce],
  );

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
      timerRef.current = null;
      firstPendingAtRef.current = null;
      const intent = readNavOrderIntent(surfaceRef.current);
      if (!intent) return;
      // 定时器路径无人 await：`startWrite` 内部已捕获失败并就地提示，
      // 不会产生未处理 rejection。
      void startWrite(surfaceRef.current, intent);
    }, delay);
  }, [clearTimer, startWrite]);

  const apply = useCallback(
    (next: string[], targetSurface: NavSurface): boolean => {
      const base = readNavOrderIntent(targetSurface)?.ids ?? committedRef.current;
      if (sameOrder(base, next)) return false;
      publishNavOrderIntent(targetSurface, next);
      schedule();
      return true;
    },
    [schedule],
  );

  const move = useCallback(
    (id: string, delta: -1 | 1) => {
      const base = readNavOrderIntent(surface)?.ids ?? committedRef.current;
      return apply(moveEntryInList(base, id, delta, fixedRef.current), surface);
    },
    [apply, surface],
  );

  const moveTo = useCallback(
    (id: string, toIndex: number) => {
      const base = readNavOrderIntent(surface)?.ids ?? committedRef.current;
      return apply(moveEntryToIndex(base, id, toIndex, fixedRef.current), surface);
    },
    [apply, surface],
  );

  const flush = useCallback(async (): Promise<void> => {
    clearTimer();
    firstPendingAtRef.current = null;
    // 收敛条件：**当前没有待保存意图，且没有在途写入**。不把「写够几轮」当成
    // 完成（旧实现 4 轮上限在持续输入时会静默留下未保存排序）。
    for (let round = 0; ; round += 1) {
      const inflight = inflightRef.current;
      if (inflight) {
        // P1：`await` 只等完成，失败信息在**结果**里。必须检查，否则调用方会
        // 以为排序保存成功，继续执行依赖它的显隐/切界面写入。
        const result = await inflight;
        if (result.status === "failed") throw result.error;
      }
      const intent = readNavOrderIntent(surfaceRef.current);
      if (!intent) return;
      // 只有「意图仍在持续变化」才会走到上限：显式失败而不是假装成功。
      if (round >= NAV_ORDER_FLUSH_MAX_ROUNDS) {
        throw new Error(FLUSH_UNSETTLED_MESSAGE);
      }
      const result = await startWrite(surfaceRef.current, intent);
      if (result.status === "failed") throw result.error;
      // success / superseded 都回到循环顶部：只有确认没有更新的意图才算收敛。
    }
  }, [clearTimer, startWrite]);

  const discard = useCallback(() => {
    clearTimer();
    firstPendingAtRef.current = null;
    // 在途写入仍会落库（整份覆盖操作在它之后执行，会盖掉它）；
    // 意图已不在，它的成功/失败都不再影响当前状态。
    dropNavOrderIntent(surfaceRef.current);
  }, [clearTimer]);

  // 切换界面：调用方已 flush / discard；这里兜底丢弃残留意图，避免把 A 的顺序写进 B。
  useEffect(() => {
    const previous = surfaceRef.current;
    if (previous === surface) return;
    surfaceRef.current = surface;
    clearTimer();
    firstPendingAtRef.current = null;
    const leftover = dropNavOrderIntent(previous);
    if (leftover) {
      // 正常路径不可达（切界面前已 flush）；留下可追踪的记录而不是静默丢弃。
      console.warn("[nav-order] 切换界面时丢弃未保存的排序", { surface: previous });
    }
  }, [surface, clearTimer]);

  // 卸载（折叠分组 / 切页）：把最后一笔顺序落库，不丢用户操作。
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      firstPendingAtRef.current = null;
      const targetSurface = surfaceRef.current;
      const pending = inflightRef.current;
      const persistLatest = () => {
        const intent = readNavOrderIntent(targetSurface);
        if (!intent) return;
        // 先不清意图：清早了侧边栏会先回旧序再跳到新序（可见闪烁）。
        void persistNavigationLayout((current) => ({
          ...current,
          [targetSurface]: intent.ids,
        }))
          .then(() => {
            clearNavOrderIntent(targetSurface, intent.seq);
          })
          .catch((error: unknown) => {
            // 组件已卸载，没有可提示的 UI：回滚 + 留下可追踪记录，不静默吞掉。
            clearNavOrderIntent(targetSurface, intent.seq);
            console.warn(
              "[nav-order] 设置页关闭时保存排序失败，已回滚到已提交顺序",
              errorMessage(error),
            );
          });
      };
      if (!pending) {
        persistLatest();
        return;
      }
      // 在途写入：先等它收尾，避免同一份意图重复写。它成功/失败都会清除自己
      // 那一份意图，这里只需处理「期间又产生了更新意图」的情况。
      void pending.then(
        (result) => {
          if (result.status === "failed") {
            // 失败已由 writeOnce 回滚；组件已卸载，没有 UI 可提示，补一条可追踪记录。
            console.warn(
              "[nav-order] 设置页关闭时排序保存失败，已回滚到已提交顺序",
              result.error.message,
            );
          }
          persistLatest();
        },
        (error: unknown) => {
          console.warn(
            "[nav-order] 设置页关闭时排序写入异常",
            errorMessage(error),
          );
          persistLatest();
        },
      );
    },
    [],
  );

  const intent = readNavOrderIntent(surface);
  return {
    ids: intent?.ids ?? (committed as string[]),
    dirty: intent !== null,
    move,
    moveTo,
    flush,
    discard,
  };
}
