//! 暂存架矩形框选手势。
//!
//! 设计要点：
//! - 从容器空白处按下，位移超过阈值后才进入框选；条目、按钮、表单控件与显式
//!   `data-no-drag` / `data-marquee-ignore` 区域不参与，避免与卡片拖出、点按冲突；
//! - 手势开始时一次性测量条目矩形并缓存内容坐标，移动/滚动期间只做算术；
//! - 指针移动用 rAF 合并，每帧最多回调一次 `move`；`pointerup` 立即用松手坐标
//!   计算最终选择并回调 `end`；
//! - 靠近容器上下边缘时每帧自动滚动 18px，并持续重算 overlay 与命中；
//! - Esc / 失焦 / 页面隐藏 / `pointercancel` 走取消路径：不提交最终选择，只通知
//!   `onCancel` 让调用方恢复原选择；
//! - 所有监听、rAF 与状态更新在结束、取消、卸载时回收；不使用 pointer capture。

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

/** 超过该位移才进入框选态，避免点击抖动触发。 */
const MARQUEE_THRESHOLD_PX = 4;
/** 指针距容器上下边缘该距离内开始自动滚动。 */
const EDGE_SCROLL_ZONE_PX = 28;
/** 自动滚动每帧步进。 */
const EDGE_SCROLL_STEP_PX = 18;
/** 框选结束后短时间吞掉 click，防止收尾 click 清空选择。 */
const CLICK_SUPPRESS_MS = 350;

/** 这些目标上的按下不启动框选（只允许从空白/容器起拖）。 */
const IGNORE_TARGET_SELECTOR = [
  "[data-shelf-id]",
  "button",
  "a",
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  "[data-no-drag]",
  "[data-marquee-ignore]",
].join(",");

export type ShelfMarqueeMode = "replace" | "toggle";

export interface ShelfMarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ShelfMarqueeOptions {
  /** 滚动容器（position:relative）；条目元素带 data-shelf-id。 */
  containerRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  /** 拖动过程中 rAF 合并后调用；end 为最终结果。 */
  onChange: (ids: string[], mode: ShelfMarqueeMode, phase: "move" | "end") => void;
  /** Esc / 失焦 / 隐藏 / pointercancel：不提交，恢复调用方原选择。 */
  onCancel?: () => void;
  /** 手势开始时读取的基准选择（Ctrl 框选做 XOR）。 */
  getBaseSelection?: () => string[];
}

export interface ShelfMarqueeHandlers {
  active: boolean;
  /** 内容坐标系（可直接作为容器内 absolute 子元素的 left/top/width/height）。 */
  rect: ShelfMarqueeRect | null;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  shouldSuppressClick: () => boolean;
}

interface CachedShelfItem {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ViewportRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface MarqueeSession {
  pointerId: number;
  container: HTMLElement;
  containerRect: ViewportRect;
  startContentLeft: number;
  startContentTop: number;
  latestClientX: number;
  latestClientY: number;
  mode: ShelfMarqueeMode;
  baseIds: string[];
  items: CachedShelfItem[];
  active: boolean;
  raf: number | null;
  /** 本手势注册的监听回收函数；结束/取消/卸载时调用。 */
  detach: () => void;
}

interface MarqueeResult {
  ids: string[];
  rect: ShelfMarqueeRect;
}

function normalizeRect(
  startLeft: number,
  startTop: number,
  currentLeft: number,
  currentTop: number,
): ShelfMarqueeRect {
  return {
    left: Math.min(startLeft, currentLeft),
    top: Math.min(startTop, currentTop),
    width: Math.abs(currentLeft - startLeft),
    height: Math.abs(currentTop - startTop),
  };
}

function collectHits(items: readonly CachedShelfItem[], rect: ShelfMarqueeRect): string[] {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const ids: string[] = [];
  for (const item of items) {
    if (
      item.left < right &&
      item.right > rect.left &&
      item.top < bottom &&
      item.bottom > rect.top
    ) {
      ids.push(item.id);
    }
  }
  return ids;
}

/** Ctrl 框选：基准选择与当前命中集合的对称差，保持“旧选择在前、新命中在后”。 */
function toggleSelection(baseIds: readonly string[], hits: readonly string[]): string[] {
  const base = new Set(baseIds);
  const hitSet = new Set(hits);
  const result: string[] = [];
  for (const id of baseIds) {
    if (!hitSet.has(id)) result.push(id);
  }
  for (const id of hits) {
    if (!base.has(id)) result.push(id);
  }
  return result;
}

function measureItems(container: HTMLElement, containerRect: ViewportRect): CachedShelfItem[] {
  const items: CachedShelfItem[] = [];
  const seen = new Set<string>();
  const scrollLeft = container.scrollLeft;
  const scrollTop = container.scrollTop;
  container.querySelectorAll<HTMLElement>("[data-shelf-id]").forEach((node) => {
    const id = node.dataset.shelfId;
    if (!id || seen.has(id)) return;
    seen.add(id);
    const bounds = node.getBoundingClientRect();
    const left = bounds.left - containerRect.left + scrollLeft;
    const top = bounds.top - containerRect.top + scrollTop;
    items.push({
      id,
      left,
      top,
      right: left + bounds.width,
      bottom: top + bounds.height,
    });
  });
  return items;
}

function computeResult(
  session: MarqueeSession,
  clientX: number,
  clientY: number,
): MarqueeResult {
  const { container, containerRect } = session;
  const currentLeft = clientX - containerRect.left + container.scrollLeft;
  const currentTop = clientY - containerRect.top + container.scrollTop;
  const rect = normalizeRect(
    session.startContentLeft,
    session.startContentTop,
    currentLeft,
    currentTop,
  );
  const hits = collectHits(session.items, rect);
  const ids =
    session.mode === "toggle" ? toggleSelection(session.baseIds, hits) : hits;
  return { ids, rect };
}

/** 指针在边缘且容器内容溢出时滚动一帧；返回是否真的改变了 scrollTop。 */
function autoScroll(session: MarqueeSession): boolean {
  if (!session.active) return false;
  const { container, containerRect } = session;
  if (container.scrollHeight <= container.clientHeight) return false;

  const distanceToTop = Math.abs(session.latestClientY - containerRect.top);
  const distanceToBottom = Math.abs(session.latestClientY - containerRect.bottom);
  const nearestEdge = Math.min(distanceToTop, distanceToBottom);
  if (nearestEdge > EDGE_SCROLL_ZONE_PX) return false;

  const direction = distanceToTop <= distanceToBottom ? -1 : 1;
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const before = container.scrollTop;
  const next = Math.min(
    maxScrollTop,
    Math.max(0, before + direction * EDGE_SCROLL_STEP_PX),
  );
  container.scrollTop = next;
  // 以赋值后的实际位置判断，避免布局限制导致“算起来变了、实际没动”时无限排帧。
  return container.scrollTop !== before;
}

export function useShelfMarquee({
  containerRef,
  enabled = true,
  onChange,
  onCancel,
  getBaseSelection,
}: ShelfMarqueeOptions): ShelfMarqueeHandlers {
  const optionsRef = useRef({ containerRef, enabled, onChange, onCancel, getBaseSelection });
  optionsRef.current = { containerRef, enabled, onChange, onCancel, getBaseSelection };

  const sessionRef = useRef<MarqueeSession | null>(null);
  const mountedRef = useRef(true);
  const suppressUntilRef = useRef(0);
  const loopRef = useRef<() => void>(() => {});
  const [active, setActive] = useState(false);
  const [rect, setRect] = useState<ShelfMarqueeRect | null>(null);

  /** 清空会话、监听与在途 rAF；不触发 React 状态或调用方回调。 */
  const clearSession = useCallback((): MarqueeSession | null => {
    const session = sessionRef.current;
    if (!session) return null;
    sessionRef.current = null;
    session.detach();
    if (session.raf !== null) {
      window.cancelAnimationFrame(session.raf);
      session.raf = null;
    }
    return session;
  }, []);

  const cancelGesture = useCallback(() => {
    const session = clearSession();
    if (!session) return;
    if (mountedRef.current) {
      setActive(false);
      setRect(null);
    }
    if (session.active) optionsRef.current.onCancel?.();
  }, [clearSession]);

  /** 只有会话仍存活且 active 时才排队，避免结束后的迟到 rAF 重开循环。 */
  const scheduleFrame = useCallback((session: MarqueeSession) => {
    if (session.raf !== null || !session.active) return;
    if (!mountedRef.current || sessionRef.current !== session) return;
    session.raf = window.requestAnimationFrame(() => loopRef.current());
  }, []);

  const tick = useCallback(() => {
    const session = sessionRef.current;
    if (!session || !session.active) return;
    session.raf = null;
    const scrolled = autoScroll(session);
    const result = computeResult(session, session.latestClientX, session.latestClientY);
    if (!mountedRef.current || sessionRef.current !== session) return;
    setRect(result.rect);
    optionsRef.current.onChange(result.ids, session.mode, "move");
    // 自动滚动期间即使指针不动也要继续下一帧；滚动到边界后停止循环。
    if (scrolled && sessionRef.current === session && session.active) {
      scheduleFrame(session);
    }
  }, [scheduleFrame]);
  loopRef.current = tick;

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const options = optionsRef.current;
      if (!options.enabled || event.button !== 0 || event.altKey) return;
      if (sessionRef.current) return;
      const target = event.target;
      if (target instanceof Element && target.closest(IGNORE_TARGET_SELECTOR)) return;

      const container = options.containerRef.current;
      if (!container) return;

      // 手势开始时测一次容器与条目几何，后续 pointermove 不再查询 DOM。
      const bounds = container.getBoundingClientRect();
      const containerRect: ViewportRect = {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
      };
      const mode: ShelfMarqueeMode =
        event.ctrlKey || event.metaKey ? "toggle" : "replace";
      const baseIds =
        mode === "toggle"
          ? [...new Set(options.getBaseSelection?.() ?? [])]
          : [];

      // 阈值用客户端坐标计算；内容坐标会随滚动变化，不能拿来判断 4px 抖动。
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const onMove = (moveEvent: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || moveEvent.pointerId !== session.pointerId) return;
        session.latestClientX = moveEvent.clientX;
        session.latestClientY = moveEvent.clientY;
        if (!session.active) {
          if (
            Math.hypot(
              moveEvent.clientX - startClientX,
              moveEvent.clientY - startClientY,
            ) <= MARQUEE_THRESHOLD_PX
          ) {
            return;
          }
          session.active = true;
          if (mountedRef.current && sessionRef.current === session) {
            setActive(true);
            // 激活首帧先给出 overlay，避免指针已移动但界面仍无反馈；
            // 后续变化仍由 rAF 合并，onChange 也只在帧回调里发布。
            setRect(computeResult(session, moveEvent.clientX, moveEvent.clientY).rect);
          }
        }
        scheduleFrame(session);
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || upEvent.pointerId !== session.pointerId) return;
        session.latestClientX = upEvent.clientX;
        session.latestClientY = upEvent.clientY;
        if (!session.active) {
          clearSession();
          if (mountedRef.current) {
            setActive(false);
            setRect(null);
          }
          return;
        }
        const result = computeResult(session, upEvent.clientX, upEvent.clientY);
        const { mode: endedMode } = session;
        clearSession();
        if (!mountedRef.current) return;
        suppressUntilRef.current = Date.now() + CLICK_SUPPRESS_MS;
        setActive(false);
        setRect(null);
        optionsRef.current.onChange(result.ids, endedMode, "end");
      };

      const onPointerCancel = (cancelEvent: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || cancelEvent.pointerId !== session.pointerId) return;
        cancelGesture();
      };

      const onKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Escape") return;
        if (!sessionRef.current) return;
        keyEvent.preventDefault();
        cancelGesture();
      };

      const onBlur = () => {
        if (sessionRef.current) cancelGesture();
      };

      // 指针离开文档（例如在窗口外松手且系统未派发 blur/pointercancel）：
      // 立即取消，避免半透明矩形与旧选择残留到下一次指针事件。
      const onPointerOut = (outEvent: PointerEvent) => {
        if (!outEvent.relatedTarget && sessionRef.current) cancelGesture();
      };

      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden" && sessionRef.current) {
          cancelGesture();
        }
      };

      const session: MarqueeSession = {
        pointerId: event.pointerId,
        container,
        containerRect,
        startContentLeft: event.clientX - containerRect.left + container.scrollLeft,
        startContentTop: event.clientY - containerRect.top + container.scrollTop,
        latestClientX: event.clientX,
        latestClientY: event.clientY,
        mode,
        baseIds,
        items: measureItems(container, containerRect),
        active: false,
        raf: null,
        detach: () => {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onPointerUp);
          document.removeEventListener("pointercancel", onPointerCancel);
          document.removeEventListener("keydown", onKeyDown);
          document.removeEventListener("visibilitychange", onVisibilityChange);
          document.removeEventListener("pointerout", onPointerOut);
          window.removeEventListener("blur", onBlur);
        },
      };
      sessionRef.current = session;
      document.addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("pointerup", onPointerUp, { passive: true });
      document.addEventListener("pointercancel", onPointerCancel, { passive: true });
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("visibilitychange", onVisibilityChange);
      document.addEventListener("pointerout", onPointerOut);
      window.addEventListener("blur", onBlur);
    },
    [cancelGesture, clearSession, scheduleFrame],
  );

  const shouldSuppressClick = useCallback(
    () => Date.now() < suppressUntilRef.current,
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearSession();
    };
  }, [clearSession]);

  return { active, rect, onPointerDown, shouldSuppressClick };
}
