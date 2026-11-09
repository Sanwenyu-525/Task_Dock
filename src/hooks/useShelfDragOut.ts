//! 暂存架系统级拖出手势。
//!
//! 只负责「按下 → 移动超过阈值 → 调用后端 OLE 拖拽」这一段：
//! - 不使用 HTML5 `draggable` / `dragstart`，也不调用 `setPointerCapture`；
//!   原生 OLE 拖拽循环会接管鼠标，WebView2 的指针捕获可能被系统改写。
//! - 必须在左键仍按下时调用后端；后端失败时用一次性 click 抑制避免误开详情。
//! - 组件卸载、pointercancel、窗口 blur 与 30s 看门狗都会回收监听与在途闸。

import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { shelfDragOut, type ShelfDragOutResult } from "../lib/bridge";
import { errorMessage } from "../lib/errors";

/** 超过该位移才认为是拖拽，避免点击时抖动误触。 */
const DRAG_THRESHOLD_PX = 5;
/** 拖拽结束后短时间吞掉 click，防止卡片按钮把拖拽当成点击。 */
const CLICK_SUPPRESS_MS = 350;
/** 原生拖拽循环最长等待；超时只释放前端在途闸，不尝试终止系统拖拽。 */
const DRAG_WATCHDOG_MS = 30_000;

export interface ShelfDragOutOptions {
  /** 返回本次应拖出的条目 id；返回空数组表示不发起。 */
  resolveIds: () => string[];
  /** link/text/missing 条目必须为 false。 */
  enabled: boolean;
  onSettled?: (result: ShelfDragOutResult, ids: string[]) => void;
  onError?: (message: string) => void;
  /** 测试/诊断用：覆盖 click 抑制时长。 */
  suppressMs?: number;
}

export interface ShelfDragOutHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** 卡片内部按钮在 click 时调用；true 表示这次 click 属于拖拽收尾。 */
  shouldSuppressClick: () => boolean;
}

interface DragStart {
  x: number;
  y: number;
  pointerId: number;
}

export function useShelfDragOut({
  resolveIds,
  enabled,
  onSettled,
  onError,
  suppressMs = CLICK_SUPPRESS_MS,
}: ShelfDragOutOptions): ShelfDragOutHandlers {
  const startRef = useRef<DragStart | null>(null);
  const draggingRef = useRef(false);
  const activeRef = useRef(false);
  const suppressUntilRef = useRef(0);
  const watchdogRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const enabledRef = useRef(enabled);
  const resolveRef = useRef(resolveIds);
  const settledRef = useRef(onSettled);
  const errorRef = useRef(onError);
  const suppressMsRef = useRef(suppressMs);

  enabledRef.current = enabled;
  resolveRef.current = resolveIds;
  settledRef.current = onSettled;
  errorRef.current = onError;
  suppressMsRef.current = suppressMs;

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const cleanupListeners = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  const resetDrag = useCallback(() => {
    draggingRef.current = false;
    startRef.current = null;
    cleanupListeners();
    clearWatchdog();
    activeRef.current = false;
  }, [cleanupListeners, clearWatchdog]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      resetDrag();
    };
  }, [resetDrag]);

  const suppressClick = useCallback(() => {
    suppressUntilRef.current = Date.now() + suppressMsRef.current;
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabledRef.current || activeRef.current) return;
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      // 勾选、更多菜单等显式交互控件不参与拖出。
      if (target?.closest?.("[data-no-drag]")) return;

      // 新的按下开始前先回收上一轮残留在非拖拽路径上的监听。
      cleanupListeners();
      clearWatchdog();
      startRef.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
      };
      draggingRef.current = false;

      const finishWithoutDrag = () => {
        if (draggingRef.current) return;
        startRef.current = null;
        cleanupListeners();
      };

      const onMove = (moveEvent: PointerEvent) => {
        const start = startRef.current;
        if (!start || moveEvent.pointerId !== start.pointerId) return;
        // 左键已经松开：没到阈值就是普通点击，不再进入拖拽。
        if ((moveEvent.buttons & 1) === 0) {
          finishWithoutDrag();
          return;
        }
        if (draggingRef.current) return;
        const distance = Math.hypot(
          moveEvent.clientX - start.x,
          moveEvent.clientY - start.y,
        );
        if (distance < DRAG_THRESHOLD_PX) return;

        const ids = resolveRef.current();
        if (ids.length === 0) {
          finishWithoutDrag();
          return;
        }

        draggingRef.current = true;
        activeRef.current = true;
        startRef.current = null;
        // 原生拖拽接管鼠标后，WebView 可能收不到 pointerup；监听到此为止。
        cleanupListeners();
        suppressClick();
        watchdogRef.current = window.setTimeout(() => {
          watchdogRef.current = null;
          if (!mountedRef.current) return;
          // 无法从外部终止系统拖拽循环，只释放前端在途闸，避免永久锁死。
          activeRef.current = false;
          draggingRef.current = false;
        }, DRAG_WATCHDOG_MS);

        void shelfDragOut(ids)
          .then((result) => {
            if (!mountedRef.current) return;
            suppressClick();
            settledRef.current?.(result, ids);
          })
          .catch((error) => {
            if (!mountedRef.current) return;
            suppressClick();
            errorRef.current?.(`拖出失败：${errorMessage(error)}`);
          })
          .finally(() => {
            clearWatchdog();
            activeRef.current = false;
            draggingRef.current = false;
          });
      };

      const onUp = (upEvent: PointerEvent) => {
        const start = startRef.current;
        if (!start || upEvent.pointerId !== start.pointerId) return;
        finishWithoutDrag();
      };

      const onCancel = (cancelEvent: PointerEvent) => {
        const start = startRef.current;
        if (!start || cancelEvent.pointerId !== start.pointerId) return;
        finishWithoutDrag();
      };

      const onBlur = () => {
        finishWithoutDrag();
      };

      document.addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("pointerup", onUp, { passive: true });
      document.addEventListener("pointercancel", onCancel, { passive: true });
      window.addEventListener("blur", onBlur);
      cleanupRef.current = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onBlur);
      };
    },
    [cleanupListeners, clearWatchdog, suppressClick],
  );

  const shouldSuppressClick = useCallback(
    () => Date.now() < suppressUntilRef.current,
    [],
  );

  return { onPointerDown, shouldSuppressClick };
}
