//! 极简吸附态（Edge Tab）：贴边细条，点击展开、沿边拖动、悬停提示、右键菜单。
//!
//! 只处理输入，不管理形态：
//! - 单击 / 键盘 Enter、Space → `restoreTab({ reveal: true })`：引擎在**同一串行
//!   事务**里先恢复轨道、再展开面板，不是两段靠延迟拼接的调用；
//! - 沿边拖动 → `dragTabBy()`，只改垂直/水平位置，不切形态；
//! - 法向（朝屏幕内部）拖动超过阈值 → 松手时走恢复；
//! - 拖动结束后不得再触发点击恢复（指针点击已在 `pointerup` 判定，
//!   `click` 只接键盘激活，`detail !== 0` 的指针 click 一律忽略）；
//! - 悬停 → 独立 `tab-hint` 窗口（10px 窄窗内的浮层会被原生区域裁成残片）；
//! - 右键 → 复用既有 `context-menu` 液态玻璃弹窗的 tab 变体。
//!
//! 可见区域由 Win32 区域裁剪（10×46），组件本身只画这一块；
//! 透明度/滑入动画由 `styles.css` 的 `.capsule-tab` 过渡类负责。
//! 提示与菜单都由**独立窗口**承载，因此不会扩大本窗的区域与命中范围。

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import type { SnapEdge } from "../../lib/edgeSnap";
import { classifyTabGesture, tabAlongDelta } from "../../lib/edgeTabGesture";
import { TAB_CLICK_SLOP_CSS } from "../../lib/capsuleLayout";
import { hideTabHint, showTabHint, showTabMenu } from "../../lib/edgeTabActions";
import { tabHintKey } from "../../lib/capsuleModel";
import { t } from "../../i18n";

/** 标签在形态过渡中的出现方式：稳定 / 收起渐显 / 恢复渐隐。 */
export type EdgeTabAppear = "idle" | "in" | "out";

/**
 * 悬停提示延迟（ms）：与 `TooltipLayer` 的 SHOW_DELAY 同一口径——鼠标只是
 * 路过标签时不闪一下。常量放在这里而不是工具提示层：提示由独立窗口承载，
 * 主窗的 TooltipLayer 无法（也不该）在 10×46 区域外绘制。
 */
const HINT_DELAY_MS = 350;

interface DragStart {
  pointerId: number;
  /** 屏幕坐标（与视口坐标解耦）：窗口移动时视口原点会随窗口变化，
   *  使用 clientX 作为拖动基准会导致位移反馈循环/重影。 */
  screenX: number;
  screenY: number;
}

export default function EdgeTab({
  edge,
  tone,
  appear = "idle",
}: {
  edge: SnapEdge;
  /** Agent 状态色（与轨道状态球同一语义，只驱动一条细指示线 + 悬停文案）。 */
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
  /** 悬停提示的延迟计时器（离开/按下/失焦/卸载都必须清掉）。 */
  const hintTimer = useRef<number | null>(null);
  /** 菜单是否正在打开：打开期间不弹提示、不再重复打开。 */
  const menuOpening = useRef(false);
  /**
   * 拖动期间挂在 window 上的收尾监听。
   *
   * 为什么需要：标签拖动时**窗口本身在被 setPosition 移动**，同时悬停提示窗
   * 会在按下瞬间隐藏（独立顶层窗口显隐）。这两种窗口级操作都会让 WebView2
   * 丢失元素的指针捕获——此时元素收不到 `pointerup`，`.is-dragging` 会一直
   * 挂着，表现就是「左键已松开仍显示 grabbing，必须动一下鼠标才恢复」。
   * 窗口级监听在捕获阶段先于 React 派发，因此正常路径也只会收尾一次。
   */
  const windowRelease = useRef<{ up: (e: PointerEvent) => void; cancel: (e: PointerEvent) => void } | null>(
    null,
  );

  const clearHintTimer = useCallback(() => {
    if (hintTimer.current !== null) {
      window.clearTimeout(hintTimer.current);
      hintTimer.current = null;
    }
  }, []);

  const hideHint = useCallback(() => {
    clearHintTimer();
    void hideTabHint();
  }, [clearHintTimer]);

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

  const detachWindowRelease = () => {
    const h = windowRelease.current;
    if (!h) return;
    windowRelease.current = null;
    window.removeEventListener("pointerup", h.up, true);
    window.removeEventListener("pointercancel", h.cancel, true);
  };

  const finish = () => {
    clearFrame();
    detachWindowRelease();
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

  /**
   * 松手/取消的**唯一**收尾路径（元素事件与窗口兜底都走这里）。
   * 指针捕获丢失后仍能从 window 收到 `pointerup`，用屏幕坐标算手势与位移。
   */
  const completeRelease = (
    pointerId: number,
    screenX: number,
    screenY: number,
    cancelled: boolean,
  ) => {
    const s = start.current;
    if (!s || s.pointerId !== pointerId) return;
    const dx = screenX - s.screenX;
    const dy = screenY - s.screenY;
    const kind = cancelled ? "cancel" : classifyTabGesture(edge, dx, dy);
    if (kind === "drag" && pendingDelta.current !== 0) {
      // 补上最后一帧被 rAF 合并的位移，松手位置与光标一致。
      dragBy?.(pendingDelta.current);
    }
    finish();
    // 点击与向内拖动都是「把胶囊拉出来」：一次到位展开最近使用的面板。
    if (kind === "click" || kind === "restore") restore?.({ reveal: true });
  };

  const attachWindowRelease = (pointerId: number) => {
    detachWindowRelease();
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      completeRelease(e.pointerId, e.screenX, e.screenY, false);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      completeRelease(e.pointerId, e.screenX, e.screenY, true);
    };
    windowRelease.current = { up, cancel };
    // 捕获阶段：即使某个中间层 stopPropagation，收尾信号也不会丢
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
  };

  // 拖动中窗口失焦 / 页面隐藏：按取消处理，不恢复形态；同时收起提示
  // （提示是独立窗口，本窗失焦不会让它自己消失）。
  useEffect(() => {
    const cancel = () => {
      hideHint();
      if (start.current) finish();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
      clearFrame();
      clearHintTimer();
      // 卸载/形态切换：独立提示窗不能留成悬空窗口；拖动兜底监听也要摘掉
      detachWindowRelease();
      void hideTabHint();
    };
  }, [clearHintTimer, hideHint]);

  /** 悬停提示：真实 Agent 状态（与轨道同一 tone 来源），不新增订阅与轮询。 */
  const hintText = t(tabHintKey(tone));

  const onPointerEnter = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    // 过渡中（正在收起/恢复）不提示：此时标签只是动画的一部分。
    if (appear !== "idle" || start.current || menuOpening.current) return;
    clearHintTimer();
    hintTimer.current = window.setTimeout(() => {
      hintTimer.current = null;
      void showTabHint(edge, hintText);
    }, HINT_DELAY_MS);
  };

  const onPointerLeave = () => {
    hideHint();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    // 拖动/单击开始即收起提示：提示不能盖在拖动手势上。
    hideHint();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    resetDragCursor();
    start.current = { pointerId: e.pointerId, screenX: e.screenX, screenY: e.screenY };
    attachWindowRelease(e.pointerId);
    beginDrag?.();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.screenX - s.screenX;
    const dy = e.screenY - s.screenY;
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
    completeRelease(e.pointerId, e.screenX, e.screenY, false);
  };

  const onPointerCancel = () => {
    // 捕获丢失/取消：有会话走完整收尾（含释放捕获），否则只清光标状态。
    if (start.current) finish();
    else resetDragCursor();
    // 取消后鼠标可能仍停在标签上：不自动重弹提示，等下一次进入。
    hideHint();
  };

  /**
   * 右键：交给既有 `context-menu` 弹窗的 tab 变体。
   * 必须 `preventDefault`，否则 WebView2 会在被裁剪的小窗口里画系统菜单/残片。
   * 右键不改变拖动会话，也不触发单击恢复。
   */
  const onContextMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // 右键按下时 onPointerDown 已按 `button !== 0` 忽略，这里不会有拖拽会话。
    hideHint();
    if (menuOpening.current) return;
    menuOpening.current = true;
    void showTabMenu(edge).finally(() => {
      menuOpening.current = false;
    });
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
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onContextMenu={onContextMenu}
      onClick={(e) => {
        // 指针点击由 pointerup 处理；这里只接键盘激活（Enter / Space），
        // 避免“拖动结束”或快速重复点击产生第二次恢复。
        if (e.detail !== 0) {
          e.preventDefault();
          return;
        }
        hideHint();
        restore?.({ reveal: true });
      }}
    >
      <span className="capsule-tab-line" aria-hidden="true" />
    </button>
  );
}
