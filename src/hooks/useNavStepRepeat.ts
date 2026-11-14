//! 上下箭头长按连续移动。
//!
//! 交互契约：
//! - 按下立即移动一格（不等待长按判定），单击行为与旧版完全一致；
//! - 按住 `HOLD_MS` 后进入连续移动，节奏 `REPEAT_MS`；
//! - 到边界（`step` 返回 false）、松开、指针离开列表、窗口失焦、页面隐藏、
//!   组件卸载或 `disabled` 变真时立刻停止并清理计时器与监听；
//! - 会话锁定**稳定入口 ID 与方向**：行随排序移动后，后续重复仍作用于同一入口，
//!   不会因为指针下方换了一行而改错目标（不依赖数组索引）。
//!
//! 指针捕获：按下时对按钮 `setPointerCapture`，行被 React 重排时按钮节点仍是
//! 同一个 DOM 节点，捕获不失效，因此长按不会因为按钮位移而中断。

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** 长按判定时长（毫秒）。 */
export const NAV_STEP_HOLD_MS = 400;
/** 连续移动节奏（毫秒）。 */
export const NAV_STEP_REPEAT_MS = 140;
/** 指针离开列表边界的容差（像素），避免轻微抖动就中断长按。 */
export const NAV_STEP_BOUNDS_PAD = 24;

export interface NavStepRepeatOptions {
  /** 执行一步；返回 false 表示已到边界，连续移动立即停止。 */
  step: (id: string, delta: -1 | 1) => boolean;
  /** 写库等忙状态：禁止开启新会话。 */
  disabled?: boolean;
  /** 指针离开该容器即停止（仅排序列表范围）。只读 current，兼容任意元素 ref。 */
  boundsRef?: { readonly current: HTMLElement | null };
  holdMs?: number;
  repeatMs?: number;
}

export interface NavStepRepeat {
  /** 按下按钮时调用（`event.currentTarget` 用于指针捕获）。 */
  start: (event: ReactPointerEvent<HTMLElement>, id: string, delta: -1 | 1) => void;
  stop: () => void;
  /** 当前按住连续移动的入口 ID（用于视觉反馈 / 阻止触屏长按菜单）。 */
  repeatingId: string | null;
}

interface StepSession {
  id: string;
  delta: -1 | 1;
  pointerId: number;
  target: HTMLElement | null;
  holdTimer: number;
  repeatTimer: number;
}

interface WindowListeners {
  onRelease: (event: PointerEvent) => void;
  onMove: (event: PointerEvent) => void;
  onBlur: () => void;
  onVisibility: () => void;
  onContextMenu: (event: Event) => void;
}

export function useNavStepRepeat(options: NavStepRepeatOptions): NavStepRepeat {
  const stepRef = useRef(options.step);
  stepRef.current = options.step;
  const disabledRef = useRef(!!options.disabled);
  disabledRef.current = !!options.disabled;
  const boundsRef = useRef(options.boundsRef);
  boundsRef.current = options.boundsRef;
  const holdMs = options.holdMs ?? NAV_STEP_HOLD_MS;
  const repeatMs = options.repeatMs ?? NAV_STEP_REPEAT_MS;

  const sessionRef = useRef<StepSession | null>(null);
  const listenersRef = useRef<WindowListeners | null>(null);
  const [repeatingId, setRepeatingId] = useState<string | null>(null);

  const detach = useCallback(() => {
    const listeners = listenersRef.current;
    if (!listeners) return;
    listenersRef.current = null;
    window.removeEventListener("pointerup", listeners.onRelease, true);
    window.removeEventListener("pointercancel", listeners.onRelease, true);
    window.removeEventListener("pointermove", listeners.onMove, true);
    window.removeEventListener("blur", listeners.onBlur);
    window.removeEventListener("contextmenu", listeners.onContextMenu, true);
    document.removeEventListener("visibilitychange", listeners.onVisibility);
  }, []);

  const stop = useCallback(() => {
    detach();
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    if (session.holdTimer) window.clearTimeout(session.holdTimer);
    if (session.repeatTimer) window.clearInterval(session.repeatTimer);
    try {
      session.target?.releasePointerCapture?.(session.pointerId);
    } catch {
      // 捕获已释放 / 元素已卸载：忽略，不阻断收尾
    }
    setRepeatingId(null);
  }, [detach]);

  const start = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string, delta: -1 | 1) => {
      if (disabledRef.current) return;
      // 只响应主键（触屏 / 笔的 button 为 0）
      if (event.button !== 0) return;
      stop();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      // 第一步同步执行：单击语义与旧版一致，也避免「按下即到边界」还留计时器。
      if (!stepRef.current(id, delta)) return;
      try {
        target.setPointerCapture?.(pointerId);
      } catch {
        // 不支持指针捕获（旧内核 / 测试环境）：仍按窗口监听收尾
      }

      const session: StepSession = {
        id,
        delta,
        pointerId,
        target,
        holdTimer: 0,
        repeatTimer: 0,
      };
      sessionRef.current = session;
      setRepeatingId(id);

      session.holdTimer = window.setTimeout(() => {
        const current = sessionRef.current;
        if (!current) return;
        current.holdTimer = 0;
        current.repeatTimer = window.setInterval(() => {
          const active = sessionRef.current;
          if (!active) return;
          if (!stepRef.current(active.id, active.delta)) stop();
        }, repeatMs);
      }, holdMs);

      const listeners: WindowListeners = {
        onRelease: (releaseEvent) => {
          if (sessionRef.current?.pointerId !== releaseEvent.pointerId) return;
          stop();
        },
        onMove: (moveEvent) => {
          const current = sessionRef.current;
          if (!current || current.pointerId !== moveEvent.pointerId) return;
          const bounds = boundsRef.current?.current;
          if (!bounds) return;
          const rect = bounds.getBoundingClientRect();
          if (
            moveEvent.clientX < rect.left - NAV_STEP_BOUNDS_PAD ||
            moveEvent.clientX > rect.right + NAV_STEP_BOUNDS_PAD ||
            moveEvent.clientY < rect.top - NAV_STEP_BOUNDS_PAD ||
            moveEvent.clientY > rect.bottom + NAV_STEP_BOUNDS_PAD
          ) {
            stop();
          }
        },
        onBlur: () => stop(),
        onVisibility: () => {
          if (document.visibilityState === "hidden") stop();
        },
        onContextMenu: (menuEvent) => {
          // 触屏长按不弹系统菜单；只在会话进行中拦截
          if (sessionRef.current) menuEvent.preventDefault();
        },
      };
      listenersRef.current = listeners;
      window.addEventListener("pointerup", listeners.onRelease, true);
      window.addEventListener("pointercancel", listeners.onRelease, true);
      window.addEventListener("pointermove", listeners.onMove, true);
      window.addEventListener("blur", listeners.onBlur);
      window.addEventListener("contextmenu", listeners.onContextMenu, true);
      document.addEventListener("visibilitychange", listeners.onVisibility);
    },
    [holdMs, repeatMs, stop],
  );

  // disabled 变真（例如别的写入开始）：立刻收尾，不留后台计时器。
  useEffect(() => {
    if (options.disabled) stop();
  }, [options.disabled, stop]);

  // 卸载：计时器、监听、指针捕获全部释放。
  useEffect(() => () => stop(), [stop]);

  return { start, stop, repeatingId };
}
