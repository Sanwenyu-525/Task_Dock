//! 「复制并切换到目标窗口」的共享状态机（完整面板与停靠胶囊唯一实现）。
//!
//! 只做 UI 状态与竞态治理，业务顺序全部在 `lib/clipboardCopySwitch.ts`：
//! precheck → copy → focus。绝不调用逐项粘贴接口。
//!
//! 竞态与生命周期：
//! - 目标枚举/复制切换各自带请求序号，旧响应不得覆盖新结果；
//! - 同一条操作在途时忽略重复触发（防连点并发写剪贴板）；
//! - 卸载后不再写状态（in-flight 结果直接丢弃）；
//! - 目标列表只在选择器挂载时读取一次 + 手动刷新，无常驻轮询。
//!
//! 统计口径：仅当复制写入成功且后端确认统计落库（`stats_recorded !== false`）时
//! 才本地累加使用次数；部分成功不得虚增。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clipboardVisibleTargets,
  type CopyReport,
  type PasteTarget,
} from "../lib/bridge";
import {
  copyAndSwitchItem,
  describeCopySwitchResult,
  focusTargetOnly,
  type CopySwitchFeedback,
  type CopySwitchResult,
} from "../lib/clipboardCopySwitch";
import { errorMessage, normalizeError } from "../lib/errors";
import { useClipboardStore } from "../store/useClipboardStore";

export type CopySwitchPhase =
  | "loading-targets"
  | "targets-error"
  | "ready"
  | "busy"
  | "retrying-focus"
  | "completed"
  | "partial"
  | "copy-failed"
  | "focus-failed";

export interface UseClipboardCopySwitch {
  targets: PasteTarget[] | null;
  targetsError: string | null;
  loadingTargets: boolean;
  busy: boolean;
  retrying: boolean;
  /** 正在处理的目标 HWND（行内 spinner；其余目标暂时禁用） */
  activeHwnd: number | null;
  result: CopySwitchResult | null;
  /** 文案（两端一致）：成功 / 部分成功 / 复制失败 / 已复制但切换失败 */
  feedback: CopySwitchFeedback | null;
  /** 条目已不存在（后端 NOT_FOUND）：调用方应刷新列表并提示 */
  itemMissing: boolean;
  phase: CopySwitchPhase;
  refresh: () => Promise<void>;
  run: (target: PasteTarget) => Promise<void>;
  /** 仅重试切换（不重复复制） */
  retryFocus: () => Promise<void>;
  reset: () => void;
}

/**
 * @param itemId 目标历史条目；条目被删除后复制会以 NOT_FOUND 失败并置 `itemMissing`
 */
export function useClipboardCopySwitch(itemId: string): UseClipboardCopySwitch {
  const [targets, setTargets] = useState<PasteTarget[] | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [loadingTargets, setLoadingTargets] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [activeHwnd, setActiveHwnd] = useState<number | null>(null);
  const [result, setResult] = useState<CopySwitchResult | null>(null);
  const [itemMissing, setItemMissing] = useState(false);

  const aliveRef = useRef(true);
  const refreshSeq = useRef(0);
  const runSeq = useRef(0);
  const busyRef = useRef(false);
  /** 本次操作的目标标题：反馈文案使用，不参与任何窗口身份判定。 */
  const targetTitleRef = useRef("");
  /**
   * 渲染期同步的当前条目 id：itemId 变化时 effect 要到提交后才执行，
   * 在途请求可能恰好在 effect 之前完成，这里给异步回调再加一道同步守卫。
   */
  const itemIdRef = useRef(itemId);
  itemIdRef.current = itemId;
  /**
   * 条目已不存在（copy 阶段 NOT_FOUND）后禁止再次发起复制：
   * 状态更新有渲染延迟，连点/其他入口可能在 setState 生效前再次触发 run。
   */
  const itemMissingRef = useRef(false);
  itemMissingRef.current = itemMissing;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // 让所有在途结果作废，卸载后不再写状态
      refreshSeq.current += 1;
      runSeq.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    setLoadingTargets(true);
    try {
      const list = await clipboardVisibleTargets();
      if (!aliveRef.current || seq !== refreshSeq.current) return;
      setTargets(list);
      setTargetsError(null);
    } catch (e) {
      if (!aliveRef.current || seq !== refreshSeq.current) return;
      // 保留上次列表但明确标记失败，不把失败伪装成「没有可见窗口」
      setTargetsError(errorMessage(e));
    } finally {
      if (aliveRef.current && seq === refreshSeq.current) setLoadingTargets(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      refreshSeq.current += 1;
    };
  }, [refresh, itemId]);

  // 条目变化（完整面板在同一位置切换到另一条详情）时作废旧操作：在途结果不得
  // 写到新条目的状态里，也不得把旧条目的成功提示显示在另一条上。
  useEffect(() => {
    runSeq.current += 1;
    busyRef.current = false;
    itemMissingRef.current = false;
    targetTitleRef.current = "";
    setResult(null);
    setItemMissing(false);
    setActiveHwnd(null);
    setBusy(false);
    // 只重试切换也可能在途：作废后必须一并落下 retrying，否则相位永久停在
    // 「retrying-focus」且重试入口一直是禁用态。
    setRetrying(false);
  }, [itemId]);

  /** 递增/读取统一在 ref 上做，避免闭包读到旧的 busy。 */
  const setBusyBoth = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
  };

  const run = useCallback(
    async (target: PasteTarget) => {
      // 条目已确认不存在后不再尝试写入；连点/延迟渲染也不能绕过。
      if (busyRef.current || itemMissingRef.current) return;
      const seq = ++runSeq.current;
      targetTitleRef.current = target.title || "";
      setActiveHwnd(target.hwnd);
      setBusyBoth(true);
      setResult(null);
      setItemMissing(false);
      try {
        const next = await copyAndSwitchItem(itemId, { hwnd: target.hwnd, pid: target.pid });
        // 条目切换后旧条目的结果一律作废（effect 的序号推进兜底，这里覆盖
        // 「提交后、effect 执行前」的微任务窗口），不得写入新条目的状态或计数。
        if (!aliveRef.current || seq !== runSeq.current || itemIdRef.current !== itemId) return;
        // 统计只认后端结果：写入成功且统计已落库才本地 +1，部分成功不虚增。
        if (next.copied && next.report && next.report.stats_recorded !== false) {
          useClipboardStore.getState().bumpItemCopy(itemId);
        }
        const missing =
          !next.copied &&
          next.failure?.stage === "copy" &&
          normalizeError(next.failure.error).code === "NOT_FOUND";
        setItemMissing(missing);
        setResult(next);
      } finally {
        if (aliveRef.current && seq === runSeq.current) {
          setBusyBoth(false);
          setActiveHwnd(null);
        }
      }
    },
    // itemId 变化时重建；store 动作通过 getState 读取，不进入依赖
    [itemId],
  );

  const retryFocus = useCallback(async () => {
    const current = result;
    const target = current?.precheckTarget;
    if (!current?.copied || !target || busyRef.current) return;
    const seq = ++runSeq.current;
    const retryItemId = itemIdRef.current;
    // 重试期间同样独占：既防连点重复切换，也阻止新的复制请求插队。
    busyRef.current = true;
    setRetrying(true);
    try {
      const r = await focusTargetOnly({ hwnd: target.hwnd, pid: target.pid });
      if (!aliveRef.current || seq !== runSeq.current || itemIdRef.current !== retryItemId) return;
      setResult((prev) =>
        prev && prev.copied
          ? {
              ...prev,
              focusTarget: r.ok ? r.target : null,
              failure: r.ok ? null : { stage: "focus", error: r.error },
            }
          : prev,
      );
    } finally {
      if (aliveRef.current && seq === runSeq.current) {
        setRetrying(false);
        busyRef.current = false;
      }
    }
  }, [result]);

  const reset = useCallback(() => {
    if (busyRef.current) return;
    runSeq.current += 1;
    setResult(null);
    setItemMissing(false);
    setActiveHwnd(null);
  }, []);

  const feedback = result
    ? describeCopySwitchResult(result, {
        targetTitle:
          result.focusTarget?.title ||
          result.precheckTarget?.title ||
          targetTitleRef.current ||
          "目标窗口",
      })
    : null;

  const phase: CopySwitchPhase = busy
    ? "busy"
    : retrying
      ? "retrying-focus"
      : result
        ? result.failure?.stage === "focus"
          ? "focus-failed"
          : result.failure
            ? "copy-failed"
            : result.partial
              ? "partial"
              : "completed"
        : loadingTargets
          ? "loading-targets"
          : targetsError
            ? "targets-error"
            : "ready";

  return {
    targets,
    targetsError,
    loadingTargets,
    busy,
    retrying,
    activeHwnd,
    result,
    feedback,
    itemMissing,
    phase,
    refresh,
    run,
    retryFocus,
    reset,
  };
}

/** 复制成功后由 UI 决定是否刷新列表：这里只导出供测试断言的类型。 */
export type CopySwitchCopyReport = CopyReport;
