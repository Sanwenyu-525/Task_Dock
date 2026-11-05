//! 极简吸附态（Edge Tab）：贴边细条，点击恢复胶囊。
//!
//! 只处理输入，不管理形态：
//! - 单击 / 键盘 Enter、Space → `restoreTab()`（引擎的同一套恢复事务）；
//! - 沿边拖动 → `dragTabBy()`，只改垂直/水平位置，不切形态；
//! - 法向（朝屏幕内部）拖动超过阈值 → 松手时走恢复；
//! - 拖动结束后不得再触发点击恢复（指针点击已在 `pointerup` 判定，
//!   `click` 只接键盘激活，`detail !== 0` 的指针 click 一律忽略）。
//!
//! 可见区域由 Win32 区域裁剪（10×46），组件本身只画这一块；
//! 透明度/滑入动画由 `styles.css` 的 `.capsule-tab` 过渡类负责。

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import type { SnapEdge } from "../../lib/edgeSnap";
import { classifyTabGesture, tabAlongDelta } from "../../lib/edgeTabGesture";
import { TAB_CLICK_SLOP_CSS } from "../../lib/capsuleLayout";
import { t } from "../../i18n";

/** 标签在形态过渡中的出现方式：稳定 / 收起渐显 / 恢复渐隐。 */
export type EdgeTabAppear = "idle" | "in" | "out";

interface DragStart {
  pointerId: number;
  x: number;
  y: number;
}

export default function EdgeTab({
  edge,
  tone,
  appear = "idle",
}: {
  edge: SnapEdge;
  /** Agent 状态色（与轨道状态球同一语义，只驱动一条细指示线）。 */
  tone: string;
  appear?: EdgeTabAppear;
}) {
  const restore = useEdgeSnapStore((s) => s.restoreTab);
  const beginDrag = useEdgeSnapStore((s) => s.beginTabDrag);
  const dragBy = useEdgeSnapStore((s) => s.dragTabBy);
  const endDrag = useEdgeSnapStore((s) => s.endTabDrag);

  const start = useRef<DragStart | null>(null);
  const frame = useRef<number | null>(null);
  const pendingDelta = useRef(0);
  const tabRef = useRef<HTMLButtonElement>(null);
  /**
   * 拖动光标状态：超过点击阈值（`classifyTabGesture` 不再是 click）后才切 grabbing，
   * 单击路径全程保持 pointer。用 ref 做同步守卫，state 只负责渲染类名。
   */
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const resetDragCursor = () => {
    draggingRef.current = false;
    setDragging(false);
  };

  const clearFrame = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    pendingDelta.current = 0;
  };

  const finish = () => {
    clearFrame();
    const s = start.current;
    start.current = null;
    // 显式释放指针捕获（松手/取消/失焦都要走这里）；已释放时 hasPointerCapture 为 false。
    const el = tabRef.current;
    if (el && s && el.hasPointerCapture?.(s.pointerId)) {
      el.releasePointerCapture?.(s.pointerId);
    }
    resetDragCursor();
    endDrag?.();
  };

  // 拖动中窗口失焦 / 页面隐藏：按取消处理，不恢复形态。
  useEffect(() => {
    const cancel = () => {
      if (start.current) finish();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
      clearFrame();
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    resetDragCursor();
    start.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    beginDrag?.();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // 超过点击阈值（任意方向 4px）即进入拖动语义；单击不会点亮 grabbing。
    if (!draggingRef.current && classifyTabGesture(edge, dx, dy) !== "click") {
      draggingRef.current = true;
      setDragging(true);
    }
    // 沿边平移：只有“明显位移”才动窗口，单击不产生位置抖动。
    const along = tabAlongDelta(edge, dx, dy);
    if (Math.abs(along) < TAB_CLICK_SLOP_CSS) return;
    pendingDelta.current = along;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      // 引擎以按下时的沿边中心为基准，这里传**累计**位移。
      dragBy?.(pendingDelta.current);
    });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const kind = classifyTabGesture(edge, dx, dy);
    if (kind === "drag" && pendingDelta.current !== 0) {
      // 补上最后一帧被 rAF 合并的位移，松手位置与光标一致。
      dragBy?.(pendingDelta.current);
    }
    finish();
    if (kind === "click" || kind === "restore") restore?.();
  };

  const onPointerCancel = () => {
    // 捕获丢失/取消：有会话走完整收尾（含释放捕获），否则只清光标状态。
    if (start.current) finish();
    else resetDragCursor();
  };

  return (
    <button
      ref={tabRef}
      type="button"
      className={[
        "capsule-tab",
        `edge-${edge}`,
        appear === "in" ? "is-in" : appear === "out" ? "is-out" : "",
        dragging ? "is-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-tone={tone}
      aria-label={t("capsule.tabAria")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onClick={(e) => {
        // 指针点击由 pointerup 处理；这里只接键盘激活（Enter / Space），
        // 避免“拖动结束”或快速重复点击产生第二次恢复。
        if (e.detail !== 0) {
          e.preventDefault();
          return;
        }
        restore?.();
      }}
    >
      <span className="capsule-tab-line" aria-hidden="true" />
    </button>
  );
}
