//! 暂存条目「Alt + 拖动到垃圾桶」的应用内手势。
//!
//! 为什么不用系统拖出：`useShelfDragOut` 会进入 Windows OLE `DoDragDrop`，
//! 在 UI 线程阻塞期间 WebView 收不到 dragover/drop，应用内垃圾桶无法可靠接收。
//! 因此内部删除使用独立的指针手势：
//! - 仅 Alt + 左键启动；普通拖动仍走原生 OLE 拖出（可拖到其他应用）；
//! - 位移超过阈值才进入拖动态，显示浮动提示；
//! - 松手时按垃圾桶元素矩形命中：命中 → `onDrop(ids)`，否则静默取消；
//! - 失焦 / pointercancel / 卸载一律取消，不留下残留状态或迟到回调。

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const DRAG_THRESHOLD_PX = 5;
const CLICK_SUPPRESS_MS = 350;

export interface ShelfInternalDragPoint {
  x: number;
  y: number;
}

export interface ShelfInternalDragOptions {
  enabled: boolean;
  /** 垃圾桶矩形（viewport 坐标）；返回 null 表示当前不可投放。 */
  getTrashRect: () => DOMRect | null;
  onDrop: (ids: string[]) => void;
  onCancel?: () => void;
}

export interface ShelfInternalDragHandlers {
  /** 在卡片 pointerdown 时调用；未按 Alt 时不启动。 */
  start: (event: ReactPointerEvent<HTMLElement>, ids: string[]) => void;
  active: boolean;
  overTrash: boolean;
  point: ShelfInternalDragPoint | null;
  /** 视为拖拽收尾的 click 应被吞掉，避免误触选择/详情。 */
  shouldSuppressClick: () => boolean;
}

interface Session {
  ids: string[];
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  overTrash: boolean;
  detach: () => void;
}

function inside(rect: DOMRect | null, x: number, y: number): boolean {
  return Boolean(
    rect &&
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom,
  );
}

export function useShelfInternalDrag({
  enabled,
  getTrashRect,
  onDrop,
  onCancel,
}: ShelfInternalDragOptions): ShelfInternalDragHandlers {
  const optionsRef = useRef({ enabled, getTrashRect, onDrop, onCancel });
  optionsRef.current = { enabled, getTrashRect, onDrop, onCancel };

  const sessionRef = useRef<Session | null>(null);
  const mountedRef = useRef(true);
  const suppressUntilRef = useRef(0);
  const [active, setActive] = useState(false);
  const [overTrash, setOverTrash] = useState(false);
  const [point, setPoint] = useState<ShelfInternalDragPoint | null>(null);

  const finish = useCallback((drop: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    session.detach();
    if (!mountedRef.current) return;
    setActive(false);
    setOverTrash(false);
    setPoint(null);
    if (drop && session.active && session.overTrash) {
      suppressUntilRef.current = Date.now() + CLICK_SUPPRESS_MS;
      optionsRef.current.onDrop(session.ids);
      return;
    }
    if (session.active) optionsRef.current.onCancel?.();
  }, []);

  const cancel = useCallback(() => finish(false), [finish]);

  const start = useCallback(
    (event: ReactPointerEvent<HTMLElement>, ids: string[]) => {
      const options = optionsRef.current;
      if (!options.enabled || event.button !== 0 || !event.altKey) return;
      if (ids.length === 0 || sessionRef.current) return;

      const startX = event.clientX;
      const startY = event.clientY;
      const onMove = (move: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || move.pointerId !== session.pointerId) return;
        if (!session.active) {
          if (Math.hypot(move.clientX - startX, move.clientY - startY) <= DRAG_THRESHOLD_PX) {
            return;
          }
          session.active = true;
          if (mountedRef.current) setActive(true);
        }
        const over = inside(optionsRef.current.getTrashRect(), move.clientX, move.clientY);
        session.overTrash = over;
        if (!mountedRef.current) return;
        setPoint({ x: move.clientX, y: move.clientY });
        setOverTrash(over);
      };

      const onUp = (up: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || up.pointerId !== session.pointerId) return;
        // 松手瞬间重新命中：最后一次 pointermove 可能早于指针进入垃圾桶。
        if (session.active) {
          session.overTrash = inside(
            optionsRef.current.getTrashRect(),
            up.clientX,
            up.clientY,
          );
        }
        finish(true);
      };

      const onCancelEvent = (cancelEvent: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || cancelEvent.pointerId !== session.pointerId) return;
        cancel();
      };

      const onBlur = () => cancel();
      const onVisibility = () => {
        if (document.visibilityState === "hidden") cancel();
      };

      const session: Session = {
        ids: [...new Set(ids)],
        pointerId: event.pointerId,
        startX,
        startY,
        active: false,
        overTrash: false,
        detach: () => {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          document.removeEventListener("pointercancel", onCancelEvent);
          document.removeEventListener("visibilitychange", onVisibility);
          window.removeEventListener("blur", onBlur);
        },
      };
      sessionRef.current = session;
      document.addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("pointerup", onUp, { passive: true });
      document.addEventListener("pointercancel", onCancelEvent, { passive: true });
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("blur", onBlur);
    },
    [cancel, finish],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      finish(false);
    };
  }, [finish]);

  return {
    start,
    active,
    overTrash,
    point,
    shouldSuppressClick: () => Date.now() < suppressUntilRef.current,
  };
}
