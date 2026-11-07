//! 极简吸附态（Edge Tab）：贴边细条，点击展开、沿边拖动、悬停提示、右键菜单。
//!
//! 只处理输入，不管理形态：
//! - 单击 / 键盘 Enter、Space → `restoreTab({ reveal: true })`：引擎在**同一串行
//!   事务**里先恢复轨道、再展开面板，不是两段靠延迟拼接的调用；
//! - 沿边拖动 → `dragTabBy()`，只改垂直/水平位置，不切形态；
//! - 法向（朝屏幕内部）拖动超过阈值 → 松手时走恢复；
//! - 拖动结束后不得再触发点击恢复（指针点击已在 `pointerup` 判定，
//!   `click` 只接键盘激活，`detail !== 0` 的指针 click 一律忽略）；
//! - 拖动期间窗口移动 / 浮层显隐导致的**指针捕获丢失不结束手势**：窗口级
//!   move 继续跟踪，松手仍由窗口级 up/cancel 收尾；pointerup 也丢失时只提交
//!   最后一次可信位移，不把“移回标签”误判成向内恢复；
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
   * 悬停会话（2026-11-07 round3）：鼠标是否真实停在标签上。
   * 拖动/右键/形变过渡/失焦都会置 false——只有它与「提示已显示」同时成立，
   * Agent 状态变化才允许原地更新提示；鼠标不在标签上时绝不凭空弹出。
   */
  const hovering = useRef(false);
  /** 当前已受理并显示的文案（null = 未显示）：用于判断文案是否真的变化。 */
  const shownHintText = useRef<string | null>(null);
  /** 显示请求单飞 + 合并：连续状态变化只保留最新文案，避免 IPC 洪泛与乱序。 */
  const hintInFlight = useRef(false);
  const hintQueuedText = useRef<string | null>(null);
  /** 悬停会话代次：hide/卸载后，迟到的 show 结果不得复活本地「已显示」标记。 */
  const hintEpoch = useRef(0);
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
  /**
   * 捕获丢失后的窗口级移动监听（只在“按键仍按下”时挂）：
   * 元素级捕获丢了以后元素收不到 `pointermove`，但窗口内仍会收到；用它继续
   * 拖动，松手时再由窗口级 `pointerup/pointercancel` 收尾。
   */
  const windowMove = useRef<((e: PointerEvent) => void) | null>(null);
  /** 是否在按键仍按下时丢失过捕获：用于识别“已松手”和“系统打断”。 */
  const captureLost = useRef(false);

  const clearHintTimer = useCallback(() => {
    if (hintTimer.current !== null) {
      window.clearTimeout(hintTimer.current);
      hintTimer.current = null;
    }
  }, []);

  /**
   * 收起提示并结束当前悬停会话（幂等）。
   * 离开/按下/右键/失焦/形变过渡/卸载都走这里：置空 `hovering` 后，后续
   * Agent 状态变化不会再把提示重新弹出来，必须等下一次真实进入。
   */
  const hideHint = useCallback(() => {
    clearHintTimer();
    hovering.current = false;
    shownHintText.current = null;
    hintQueuedText.current = null;
    hintEpoch.current += 1;
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
    if (h) {
      windowRelease.current = null;
      window.removeEventListener("pointerup", h.up, true);
      window.removeEventListener("pointercancel", h.cancel, true);
    }
    const move = windowMove.current;
    if (move) {
      windowMove.current = null;
      window.removeEventListener("pointermove", move, true);
    }
  };

  const finish = () => {
    clearFrame();
    detachWindowRelease();
    captureLost.current = false;
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
   * 松手/取消的**唯一**可信收尾路径（元素事件与窗口级 up/cancel 都走这里）。
   * 捕获丢失后 `buttons=0` 的移动不经过这里：那种情况下松手位置已不可信，
   * 由 `attachWindowMove` 只提交最后一次可信位移并结束，不触发恢复。
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
    if (kind === "drag") {
      // 以松手坐标为最后一帧：rAF 可能吞掉尾段 pointermove，捕获丢失后
      // 元素级移动也不再到达。累计位移是绝对量，重复提交不会叠加。
      const along = tabAlongDelta(edge, dx, dy);
      if (Math.abs(along) >= TAB_CLICK_SLOP_CSS) dragBy?.(along);
    }
    finish();
    // 点击与向内拖动都是「把胶囊拉出来」：一次到位展开最近使用的面板。
    if (kind === "click" || kind === "restore") void restore?.({ reveal: true });
  };

  /** 指针移动的共用路径：元素事件与捕获丢失后的窗口事件都走这里。 */
  const handleMove = (pointerId: number, screenX: number, screenY: number) => {
    const s = start.current;
    if (!s || s.pointerId !== pointerId) return;
    const dx = screenX - s.screenX;
    const dy = screenY - s.screenY;
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

  /**
   * 捕获丢失但按键仍按下：用窗口级移动继续拖动。
   *
   * 这是 P2-1 的根因修复点。WebView2 在窗口被 `setPosition` 移动或独立浮层
   * 显隐时会提前丢掉元素级指针捕获；此时**不能**当成取消结束手势，否则
   * 拖动中途停住、末段位移丢失。窗口级监听与元素路径共用 `completeRelease`，
   * 因此重复到达的 pointerup 也只会收尾一次。
   */
  const attachWindowMove = (pointerId: number) => {
    if (windowMove.current) return;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      // 降级模式下 buttons=0 说明 pointerup 也丢了。此时**不能**把当前坐标
      // 当成松手位置：指针可能在标签外松开后又移回来，向内距离会被误判成
      // “向内拖动恢复”。只提交最后一次按键按下时的可信位移，然后无恢复收尾。
      if (captureLost.current && e.buttons === 0) {
        if (pendingDelta.current !== 0) {
          dragBy?.(pendingDelta.current);
        }
        finish();
        return;
      }
      handleMove(e.pointerId, e.screenX, e.screenY);
    };
    windowMove.current = move;
    window.addEventListener("pointermove", move, true);
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
      // 卸载/形态切换：独立提示窗不能留成悬空窗口；在途 show 结果也一并作废
      detachWindowRelease();
      hideHint();
    };
  }, [clearHintTimer, hideHint]);

  /** 悬停提示：真实 Agent 状态（与轨道同一 tone 来源），不新增订阅与轮询。 */
  const hintText = t(tabHintKey(tone));

  /** 最新文案：350ms 计时器与状态更新路径都读 ref，避免闭包拿到旧文案。 */
  const hintTextRef = useRef(hintText);
  hintTextRef.current = hintText;

  /**
   * 发送一次提示显示请求（单飞 + 合并）。
   *
   * - 文案变化时**原地更新**：后端推进代次、提示窗重测尺寸，全程不 hide，
   *   因此不会出现先隐藏再闪现的抖动；
   * - 请求在途时只记住最新文案，兑现后再发一次：连续状态变化不会放大 IPC；
   * - 结果只认本悬停会话（`hintEpoch`）：离开/按下之后的迟到受理不得把本地
   *   「已显示」标记复活。
   */
  const pushHint = useCallback(
    (text: string) => {
      if (!text) return;
      if (hintInFlight.current) {
        hintQueuedText.current = text;
        return;
      }
      const epoch = hintEpoch.current;
      hintInFlight.current = true;
      void showTabHint(edge, text)
        .then((accepted) => {
          hintInFlight.current = false;
          if (epoch !== hintEpoch.current) return; // 会话已结束：丢弃迟到结果
          if (accepted) shownHintText.current = text;
          const next = hintQueuedText.current;
          hintQueuedText.current = null;
          if (next && next !== text && hovering.current) pushHint(next);
        })
        .catch(() => {
          hintInFlight.current = false;
        });
    },
    [edge],
  );

  // 悬停期间 Agent 状态变化：只更新**已请求过**的提示，且只在文案真正变化时发请求。
  // - 已显示：原地更新，不先 hide；
  // - 首个 show 还在途中：交给单飞队列，兑现后补发最新文案（否则「计时器刚触发、
  //   IPC 还没回」这段窗口里的状态变化会被丢掉）；
  // - 尚未请求（350ms 计时器还没到）：不动，计时器回调会读最新文案。
  useEffect(() => {
    if (!hovering.current) return;
    if (appear !== "idle" || start.current || menuOpening.current) return;
    const shown = shownHintText.current;
    if (shown === hintText) return;
    if (shown === null && !hintInFlight.current) return;
    pushHint(hintText);
  }, [hintText, appear, pushHint]);

  // 形态过渡（收起/恢复）期间标签只是动画的一部分：立即收起提示，之后等下一次进入。
  useEffect(() => {
    if (appear === "idle") return;
    hideHint();
  }, [appear, hideHint]);

  const onPointerEnter = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    // 过渡中（正在收起/恢复）不提示：此时标签只是动画的一部分。
    if (appear !== "idle" || start.current || menuOpening.current) return;
    hovering.current = true;
    clearHintTimer();
    hintTimer.current = window.setTimeout(() => {
      hintTimer.current = null;
      // 计时期间鼠标可能离开、开始拖动，状态也可能已经变化：只认当前最新文案
      if (!hovering.current || start.current || menuOpening.current) return;
      pushHint(hintTextRef.current);
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
    captureLost.current = false;
    resetDragCursor();
    start.current = { pointerId: e.pointerId, screenX: e.screenX, screenY: e.screenY };
    attachWindowRelease(e.pointerId);
    beginDrag?.();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    handleMove(e.pointerId, e.screenX, e.screenY);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    completeRelease(e.pointerId, e.screenX, e.screenY, false);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    // 其他指针的取消不得结束当前手势（例如多指/触控板并发事件）。
    if (s && e.pointerId !== s.pointerId) return;
    // 真正的 pointercancel：有会话走完整收尾（含释放捕获），否则只清光标状态。
    if (s) finish();
    else resetDragCursor();
    // 取消后鼠标可能仍停在标签上：不自动重弹提示，等下一次进入。
    hideHint();
  };

  /**
   * 指针捕获丢失（P2-1 根因路径）。
   *
   * - 正常松手后浏览器 release capture 也会派发本事件：那时 `start` 已清空，
   *   上面的守卫直接返回，不会重复 `endDrag`；
   * - 按键仍按下（`buttons !== 0`）说明是窗口移动/独立浮层显隐把捕获打断了，
   *   **不能**当成取消。保留会话并改由窗口级移动继续，松手仍由窗口兜底收尾；
   * - `buttons === 0` 表示松手事件本身丢了，本事件带着最终坐标，直接按松手判定。
   */
  const onLostPointerCapture = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (e.buttons === 0) {
      completeRelease(e.pointerId, e.screenX, e.screenY, false);
      return;
    }
    captureLost.current = true;
    attachWindowMove(e.pointerId);
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
      // 极简标签有独立的 tab-hint 提示窗口（主窗区域被裁切，TooltipLayer 画不出来），
      // 显式退出 aria-label 回退，避免同时弹两条提示。
      data-tip-skip="1"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onContextMenu={onContextMenu}
      onClick={(e) => {
        // 指针点击由 pointerup 处理；这里只接键盘激活（Enter / Space），
        // 避免“拖动结束”或快速重复点击产生第二次恢复。
        if (e.detail !== 0) {
          e.preventDefault();
          return;
        }
        hideHint();
        void restore?.({ reveal: true });
      }}
    >
      <span className="capsule-tab-line" aria-hidden="true" />
    </button>
  );
}
