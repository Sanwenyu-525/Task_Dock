//! 工具面板宽度拖拽手柄。
//!
//! 位置：面板**朝屏幕内侧**的竖边（左停靠=右边、右停靠=左边、上/下停靠=右边），
//! 绝对定位在面板 14px 内边距内，不覆盖滚动条与右上角关闭按钮。
//!
//! 交互契约：
//! - 拖拽只改宽度：窗口在停靠时已按最大容器预留，引擎只重写 Win32 区域，
//!   不调用 setSize/setPosition（见 `capsuleLayout.capsuleContainerSize`）；
//! - 映射方向：左停靠 `+dx`、右停靠 `−dx`、上/下停靠 `+2×dx`（面板居中，
//!   两边对称展开，手柄始终跟随光标）；
//! - 宽度按 280–480 收敛（`clampPanelWidth`），松手时提交并持久化；
//! - 键盘 ←/→ ±8（Shift ±32），Home/End 到最小/最大，双击恢复默认 340。
//!
//! 指针收尾沿用 `EdgeTab` 的 WebView2 兜底：元素捕获之外再挂窗口级
//! `pointermove/pointerup/pointercancel`，捕获丢失时手势不会停在中途；
//! 所有收尾路径共用 `finish`，重复到达的 up 只提交一次。

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import type { SnapEdge } from "../../lib/edgeSnap";
import {
  PANEL_MAX_WIDTH_CSS,
  PANEL_MIN_WIDTH_CSS,
  PANEL_WIDTH_CSS,
  clampPanelWidth,
} from "../../lib/capsuleLayout";
import { useLocale } from "../../hooks/useLocale";

/** 拖拽到该位移后才把手柄置为 active（仅视觉反馈，不影响宽度计算）。 */
const DRAG_ACTIVE_SLOP_CSS = 2;
/** 键盘步长（CSS px）：普通 8、Shift 32。 */
const KEY_STEP_CSS = 8;
const KEY_STEP_LARGE_CSS = 32;

interface DragSession {
  pointerId: number;
  startScreenX: number;
  startWidthCss: number;
  moved: boolean;
}

interface WindowListeners {
  move: (e: PointerEvent) => void;
  up: (e: PointerEvent) => void;
  cancel: (e: PointerEvent) => void;
}

/**
 * 指针位移 → 面板宽度。
 *
 * 上/下停靠的面板水平居中：宽度增加 2×dx 时左右两边各外移 dx，手柄（右边）
 * 正好落在光标下；左右停靠的面板一侧固定，1:1 跟随。
 */
export function widthFromDragDelta(edge: SnapEdge, startWidthCss: number, dx: number): number {
  const factor = edge === "right" ? -1 : edge === "top" || edge === "bottom" ? 2 : 1;
  return clampPanelWidth(startWidthCss + factor * dx);
}

/** 键盘方向 → 宽度（视觉方向：← 收窄、→ 加宽；右停靠的边在左侧，方向相反）。 */
export function widthFromKey(edge: SnapEdge, currentWidthCss: number, delta: number): number {
  const factor = edge === "right" ? -1 : 1;
  return clampPanelWidth(currentWidthCss + factor * delta);
}

export default function PanelResizeHandle({ edge }: { edge: SnapEdge }) {
  const width = useEdgeSnapStore((s) => s.panelWidth);
  const resize = useEdgeSnapStore((s) => s.resizePanel);
  const { t } = useLocale();

  const handleRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragSession | null>(null);
  const listeners = useRef<WindowListeners | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<{ pointerId: number; screenX: number } | null>(null);
  /** 手势内的最新宽度：键盘/双击以此为基准，避免依赖 React 渲染时序。 */
  const liveWidth = useRef(width);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!drag.current) liveWidth.current = width;
  }, [width]);

  const clearFrame = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    pending.current = null;
  }, []);

  const detachWindow = useCallback(() => {
    const h = listeners.current;
    if (!h) return;
    listeners.current = null;
    window.removeEventListener("pointermove", h.move, true);
    window.removeEventListener("pointerup", h.up, true);
    window.removeEventListener("pointercancel", h.cancel, true);
  }, []);

  const releaseCapture = useCallback((pointerId: number) => {
    const el = handleRef.current;
    if (el?.hasPointerCapture?.(pointerId)) el.releasePointerCapture?.(pointerId);
  }, []);

  /** 唯一收尾路径：可选地以松手坐标提交，然后清空引用与窗口监听。 */
  const finish = useCallback(
    (screenX: number | null, commit: boolean) => {
      const s = drag.current;
      clearFrame();
      detachWindow();
      drag.current = null;
      setDragging(false);
      if (s) {
        releaseCapture(s.pointerId);
        if (commit && screenX !== null) {
          const next = widthFromDragDelta(edge, s.startWidthCss, screenX - s.startScreenX);
          liveWidth.current = next;
          resize?.(next, true);
        }
      }
    },
    [clearFrame, detachWindow, edge, releaseCapture, resize],
  );

  /** 逐帧更新（rAF 合并高频 pointermove），只改宽度不提交。 */
  const scheduleUpdate = useCallback(
    (screenX: number) => {
      const s = drag.current;
      if (!s) return;
      pending.current = { pointerId: s.pointerId, screenX };
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const p = pending.current;
        pending.current = null;
        if (!p || !drag.current || p.pointerId !== drag.current.pointerId) return;
        const next = widthFromDragDelta(
          edge,
          drag.current.startWidthCss,
          p.screenX - drag.current.startScreenX,
        );
        if (next === liveWidth.current) return;
        liveWidth.current = next;
        resize?.(next, false);
      });
    },
    [edge, resize],
  );

  const attachWindow = useCallback(
    (pointerId: number) => {
      detachWindow();
      const move = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        const s = drag.current;
        if (!s) return;
        if (!s.moved && Math.abs(e.screenX - s.startScreenX) >= DRAG_ACTIVE_SLOP_CSS) {
          s.moved = true;
          setDragging(true);
        }
        scheduleUpdate(e.screenX);
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        finish(e.screenX, true);
      };
      const cancel = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        finish(null, false);
      };
      listeners.current = { move, up, cancel };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", cancel, true);
    },
    [detachWindow, finish, scheduleUpdate],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!resize) return;
    e.preventDefault();
    // 双击的第二下也会进入这里：先正常开始手势，dblclick 再恢复默认宽度。
    handleRef.current?.setPointerCapture?.(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      startScreenX: e.screenX,
      startWidthCss: clampPanelWidth(liveWidth.current),
      moved: false,
    };
    setDragging(false);
    attachWindow(e.pointerId);
  };

  /** 捕获丢失：按键仍按下时改由窗口监听继续；已松手（buttons=0）则按松手收尾。 */
  const onLostPointerCapture = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = drag.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (e.buttons === 0) finish(e.screenX, true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_LARGE_CSS : KEY_STEP_CSS;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = widthFromKey(edge, liveWidth.current, -step);
    else if (e.key === "ArrowRight") next = widthFromKey(edge, liveWidth.current, step);
    else if (e.key === "Home") next = PANEL_MIN_WIDTH_CSS;
    else if (e.key === "End") next = PANEL_MAX_WIDTH_CSS;
    if (next === null) return;
    e.preventDefault();
    liveWidth.current = next;
    resize?.(next, true);
  };

  // 卸载/收起面板时若有未收尾的手势：先清理监听，再按最后一次宽度提交，
  // 避免「引擎宽度已变、store 仍是旧值」在再次展开时错位。
  useEffect(() => {
    return () => {
      clearFrame();
      detachWindow();
      const s = drag.current;
      drag.current = null;
      if (s) {
        releaseCapture(s.pointerId);
        resize?.(liveWidth.current, true);
      }
    };
  }, [clearFrame, detachWindow, releaseCapture, resize]);

  if (!resize) return null;

  return (
    <div
      ref={handleRef}
      className={`cap-resize${dragging ? " is-active" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("capsule.resizeAria")}
      aria-valuenow={width}
      aria-valuemin={PANEL_MIN_WIDTH_CSS}
      aria-valuemax={PANEL_MAX_WIDTH_CSS}
      aria-valuetext={t("capsule.resizeValue", { width })}
      // 提示朝面板内部展开：手柄贴着区域边缘，朝外会落到被 Win32 裁掉的像素里。
      data-tip={t("capsule.resizeTip")}
      data-tip-placement={edge === "right" ? "right" : "left"}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        liveWidth.current = PANEL_WIDTH_CSS;
        resize?.(PANEL_WIDTH_CSS, true);
      }}
    />
  );
}
