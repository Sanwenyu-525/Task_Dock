//! 导航项指针拖拽排序。
//!
//! 设计要点（与「边拖边重排数组」的实现刻意区分）：
//! - **拖拽期间不改顺序数组**：只计算「松手会落到哪个索引」，用 transform 让
//!   其它行平滑让位。这样没有中途写库、没有列表重排导致的滚动跳变，也没有
//!   被拖行 DOM 位置反复变化带来的闪烁；
//! - 拖拽开始时测量一次行矩形（内容坐标），之后每帧只做算术，不在 pointermove
//!   里读布局；自动滚动让内容坐标连续变化，公式仍然成立；
//! - 指针捕获 + 窗口级监听：快速甩动、移出窗口、触屏都能正确收到结束事件；
//!   松手/取消/卸载都会移除监听、取消 rAF、释放捕获；
//! - Esc 取消：顺序数组从未改动，因此「恢复原顺序」不需要额外回滚。

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  autoScrollStep,
  dropIndexForPoint,
  reorderShifts,
  type NavReorderSlot,
} from "../lib/navReorder";
import { moveEntryToIndex } from "../lib/navVisibility";
import { registerOverlay } from "../lib/overlayStack";

/** 超过该位移才进入拖拽态，避免点击手柄被误判成拖拽。 */
const DRAG_THRESHOLD = 5;

const EMPTY_SHIFTS = new Map<string, number>();

export interface NavDragSortOptions {
  /** 列表滚动容器（自动滚动与测量范围都限制在它内部）。只读 current，兼容任意元素 ref。 */
  listRef: { readonly current: HTMLElement | null };
  /** 参与排序的可见入口（数组顺序），拖拽只在这个集合内生效。 */
  orderIds: readonly string[];
  isFixed: (id: string) => boolean;
  disabled?: boolean;
  onDrop: (id: string, toIndex: number) => void;
  onCancel?: () => void;
}

export interface NavDragSortView {
  draggingId: string | null;
  /** 被拖行相对自身位置的竖向位移（px）。 */
  offsetY: number;
  /** 其它行的让位位移（id → px）。 */
  shifts: Map<string, number>;
  /** 落点指示线的内容坐标 top；无有效落点时为 null。 */
  dropLineTop: number | null;
  beginDrag: (event: ReactPointerEvent<HTMLElement>, id: string) => void;
  /** 取消当前拖拽（不改顺序）。 */
  cancel: () => void;
}

interface DragSession {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  startContentY: number;
  lastClientY: number;
  slots: NavReorderSlot[];
  order: string[];
  active: boolean;
  fromIndex: number;
  finalIndex: number;
  raf: number;
  target: HTMLElement | null;
}

interface DragListeners {
  onMove: (event: PointerEvent) => void;
  onEnd: (event: PointerEvent) => void;
  onCancel: (event: PointerEvent) => void;
  onKey: (event: KeyboardEvent) => void;
  onBlur: () => void;
}

interface DragViewState {
  id: string;
  offsetY: number;
  finalIndex: number;
  lineTop: number | null;
  shifts: Map<string, number>;
  slots: NavReorderSlot[];
}

function measureSlots(
  container: HTMLElement,
  containerRect: DOMRect,
  order: readonly string[],
): NavReorderSlot[] {
  const allowed = new Set(order);
  const slots: NavReorderSlot[] = [];
  container.querySelectorAll<HTMLElement>("[data-nav-entry]").forEach((node) => {
    const id = node.dataset.navEntry;
    if (!id || !allowed.has(id)) return;
    const rect = node.getBoundingClientRect();
    slots.push({
      id,
      top: rect.top - containerRect.top + container.scrollTop,
      height: rect.height,
    });
  });
  return slots.sort((a, b) => a.top - b.top);
}

export function useNavDragSort(options: NavDragSortOptions): NavDragSortView {
  const listRef = useRef(options.listRef);
  listRef.current = options.listRef;
  const orderRef = useRef(options.orderIds);
  orderRef.current = options.orderIds;
  const fixedRef = useRef(options.isFixed);
  fixedRef.current = options.isFixed;
  const disabledRef = useRef(!!options.disabled);
  disabledRef.current = !!options.disabled;
  const onDropRef = useRef(options.onDrop);
  onDropRef.current = options.onDrop;
  const onCancelRef = useRef(options.onCancel);
  onCancelRef.current = options.onCancel;

  const sessionRef = useRef<DragSession | null>(null);
  const listenersRef = useRef<DragListeners | null>(null);
  const releaseEscapeLayerRef = useRef<(() => void) | null>(null);
  const cancelRef = useRef<() => void>(() => {});
  const loopRef = useRef<() => void>(() => {});
  const [view, setView] = useState<DragViewState | null>(null);

  const compute = useCallback(
    (
      session: DragSession,
      container: HTMLElement,
      rect: DOMRect,
    ): { offset: number; finalIndex: number; shifts: Map<string, number>; lineTop: number | null } => {
      const contentY = session.lastClientY - rect.top + container.scrollTop;
      const offset = contentY - session.startContentY;
      const desired = dropIndexForPoint(session.slots, session.id, contentY);
      // 顺序变更由纯函数决定：固定入口原地不动，普通入口落点被钳制在可排序段内。
      const next = moveEntryToIndex(session.order, session.id, desired, fixedRef.current);
      const finalIndex = next.indexOf(session.id);
      const moved = finalIndex !== session.fromIndex;
      const shifts = moved
        ? reorderShifts(session.slots, session.id, finalIndex, fixedRef.current)
        : EMPTY_SHIFTS;
      const slot = session.slots[Math.min(Math.max(finalIndex, 0), session.slots.length - 1)];
      const lineTop = moved && slot ? slot.top : null;
      return { offset, finalIndex, shifts, lineTop };
    },
    [],
  );

  const publish = useCallback(
    (
      session: DragSession,
      computed: { offset: number; finalIndex: number; shifts: Map<string, number>; lineTop: number | null },
    ) => {
      const offsetY = Math.round(computed.offset);
      setView((prev) => {
        if (
          prev &&
          prev.id === session.id &&
          prev.offsetY === offsetY &&
          prev.finalIndex === computed.finalIndex
        ) {
          return prev;
        }
        return {
          id: session.id,
          offsetY,
          finalIndex: computed.finalIndex,
          lineTop: computed.lineTop,
          shifts: computed.shifts,
          slots: session.slots,
        };
      });
    },
    [],
  );

  const detach = useCallback(() => {
    const listeners = listenersRef.current;
    if (!listeners) return;
    listenersRef.current = null;
    window.removeEventListener("pointermove", listeners.onMove, true);
    window.removeEventListener("pointerup", listeners.onEnd, true);
    window.removeEventListener("pointercancel", listeners.onCancel, true);
    window.removeEventListener("keydown", listeners.onKey, true);
    window.removeEventListener("blur", listeners.onBlur);
  }, []);

  const cleanup = useCallback(() => {
    detach();
    // Escape 层与拖拽会话同生共死：拖拽结束立即让出 Escape 给其它层。
    releaseEscapeLayerRef.current?.();
    releaseEscapeLayerRef.current = null;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      if (session.raf) cancelAnimationFrame(session.raf);
      try {
        session.target?.releasePointerCapture?.(session.pointerId);
      } catch {
        // 捕获已释放 / 节点已卸载：忽略
      }
    }
    document.body.classList.remove("nav-reorder-dragging");
    setView(null);
  }, [detach]);

  /** 每帧：边缘自动滚动 + 重算落点/让位。 */
  const tick = useCallback(() => {
    const session = sessionRef.current;
    const container = listRef.current?.current;
    if (!session || !session.active || !container) {
      if (session) session.raf = 0;
      return;
    }
    const rect = container.getBoundingClientRect();
    const delta = autoScrollStep(session.lastClientY, rect.top, rect.bottom);
    if (delta !== 0) container.scrollTop += delta;
    publish(session, compute(session, container, rect));
    session.raf = requestAnimationFrame(loopRef.current);
  }, [compute, publish]);
  loopRef.current = tick;

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string) => {
      if (disabledRef.current) return;
      if (event.button !== 0) return;
      if (fixedRef.current(id)) return;
      const container = listRef.current?.current;
      if (!container) return;
      const order = [...orderRef.current];
      if (!order.includes(id)) return;
      const rect = container.getBoundingClientRect();
      const slots = measureSlots(container, rect, order);
      const fromIndex = slots.findIndex((slot) => slot.id === id);
      if (fromIndex < 0) return;
      cleanup();

      const session: DragSession = {
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startContentY: event.clientY - rect.top + container.scrollTop,
        lastClientY: event.clientY,
        slots,
        order,
        active: false,
        fromIndex,
        finalIndex: fromIndex,
        raf: 0,
        target: event.currentTarget,
      };
      sessionRef.current = session;

      const listeners: DragListeners = {
        onMove: (moveEvent) => {
          const current = sessionRef.current;
          if (!current || moveEvent.pointerId !== current.pointerId) return;
          current.lastClientY = moveEvent.clientY;
          const node = listRef.current?.current;
          if (!node) return;
          if (!current.active) {
            if (
              Math.abs(moveEvent.clientX - current.startX) < DRAG_THRESHOLD &&
              Math.abs(moveEvent.clientY - current.startY) < DRAG_THRESHOLD
            ) {
              return;
            }
            current.active = true;
            try {
              current.target?.setPointerCapture?.(current.pointerId);
            } catch {
              // 旧内核 / 测试环境：窗口监听已足够收尾
            }
            document.body.classList.add("nav-reorder-dragging");
            // Esc 取消接入统一弹层栈：全局 Escape 分发器在 capture 阶段
            // stopImmediatePropagation，任何「后来注册的 keydown 监听」都收不到
            // Escape。注册一层（root 指向列表，用于嵌套深度判定）后，
            // 一次 Escape 只取消拖拽，不会顺手关掉别的弹层或把窗口藏进托盘。
            releaseEscapeLayerRef.current = registerOverlay({
              kind: "sublayer",
              root: node,
              onEscape: () => cancelRef.current(),
            });
            current.raf = requestAnimationFrame(loopRef.current);
          }
          const moveRect = node.getBoundingClientRect();
          publish(current, compute(current, node, moveRect));
        },
        onEnd: (endEvent) => {
          const current = sessionRef.current;
          if (!current || endEvent.pointerId !== current.pointerId) return;
          if (!current.active) {
            cleanup();
            return;
          }
          // 以松手坐标做最后一次计算，避免比 rAF 落后一帧落错位
          const node = listRef.current?.current;
          if (node) {
            current.lastClientY = endEvent.clientY;
            const endRect = node.getBoundingClientRect();
            current.finalIndex = compute(current, node, endRect).finalIndex;
          }
          const { id: movedId, finalIndex, fromIndex: originIndex } = current;
          cleanup();
          if (finalIndex !== originIndex) onDropRef.current(movedId, finalIndex);
        },
        onCancel: (cancelEvent) => {
          const current = sessionRef.current;
          if (!current || cancelEvent.pointerId !== current.pointerId) return;
          const wasActive = current.active;
          cleanup();
          if (wasActive) onCancelRef.current?.();
        },
        onKey: (keyEvent) => {
          if (keyEvent.key !== "Escape") return;
          if (!sessionRef.current) return;
          keyEvent.preventDefault();
          const wasActive = sessionRef.current.active;
          cleanup();
          if (wasActive) onCancelRef.current?.();
        },
        onBlur: () => {
          const wasActive = !!sessionRef.current?.active;
          cleanup();
          if (wasActive) onCancelRef.current?.();
        },
      };
      listenersRef.current = listeners;
      window.addEventListener("pointermove", listeners.onMove, true);
      window.addEventListener("pointerup", listeners.onEnd, true);
      window.addEventListener("pointercancel", listeners.onCancel, true);
      window.addEventListener("keydown", listeners.onKey, true);
      window.addEventListener("blur", listeners.onBlur);
    },
    [cleanup, compute, publish],
  );

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const wasActive = session.active;
    cleanup();
    if (wasActive) onCancelRef.current?.();
  }, [cleanup]);
  cancelRef.current = cancel;

  useEffect(() => () => cleanup(), [cleanup]);

  return {
    draggingId: view?.id ?? null,
    offsetY: view?.offsetY ?? 0,
    shifts: view?.shifts ?? EMPTY_SHIFTS,
    dropLineTop: view?.lineTop ?? null,
    beginDrag,
    cancel,
  };
}
