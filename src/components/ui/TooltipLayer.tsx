//! 全局控件提示层：**一个**实例承载全应用的控件提示。
//!
//! 为什么不做成「每个控件一个 Tooltip 组件」：应用里有上百个图标按钮，
//! 逐个挂浮层实例会带来上百个 Popover。这里改成**事件委托**——
//! 控件只声明 `data-tip="提示文案"`，由这一层统一监听 hover 与**键盘（Tab）聚焦**，
//! 全局只渲染一个提示条。
//!
//! 约束：
//! - 不参与 Escape 弹层栈：它是瞬时提示，不该挡住「Esc 隐藏窗口」；
//! - `pointer-events: none`，不挡点击、不触发 outsidePress；
//! - 不抢焦点：关闭提示条时绝不把焦点夺回去（否则用户 Tab 走会被拽回原处）；
//! - 方向默认向上；锚点可用 `data-tip-placement`（top/bottom/left/right）改向，
//!   距离可用 `data-tip-offset`（0–64，CSS px）微调；
//!   供「气泡会落在原生区域之外」的锚点（胶囊轨道）把气泡指向可见区；
//! - 与原生 `title` 互斥：需要主题化提示的控件用 `data-tip`，
//!   纯文本截断提示（非交互元素）仍然保留原生 `title`。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Placement } from "@floating-ui/react";
import Popover from "./Popover";

/** 悬停多久才出现：避免鼠标路过时闪一下。 */
const SHOW_DELAY = 350;
/** 移出多久才消失：允许鼠标从按钮移到提示条本身。 */
const HIDE_DELAY = 90;
/** 允许锚点用 `data-tip-placement` 覆盖弹出方向；白名单之外一律按默认向上处理。 */
const TIP_PLACEMENTS = ["top", "bottom", "left", "right"] as const;
function readPlacement(el: HTMLElement): Placement {
  const raw = el.dataset.tipPlacement?.trim() ?? "";
  return (TIP_PLACEMENTS as readonly string[]).includes(raw) ? (raw as Placement) : "top";
}
/** 气泡与锚点的默认外扩距离。 */
const DEFAULT_OFFSET = 6;
/** `data-tip-offset` 上限：再远就不像同一个控件的提示了。 */
const MAX_OFFSET = 64;
/** 允许锚点微调外扩距离（胶囊展开态要把气泡推到面板的可见区域内）。 */
function readOffset(el: HTMLElement): number {
  const raw = el.dataset.tipOffset?.trim();
  if (!raw) return DEFAULT_OFFSET;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(MAX_OFFSET, Math.max(0, Math.round(n))) : DEFAULT_OFFSET;
}

/** 气泡与窗口边缘的最小留白。 */
const VIEWPORT_PADDING = 8;

export interface TipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TipViewport {
  width: number;
  height: number;
}

/**
 * 提示条定位（纯函数）：
 * 1. **先居中**：top/bottom 以锚点水平中心对齐（`left + width/2 - tipWidth/2`），
 *    left/right 以锚点垂直中心对齐（`top + height/2 - tipHeight/2`）；
 *    与图标左/上对齐是错误做法，会表现为整条气泡明显偏右/偏下。
 * 2. `offset` 只改「气泡与锚点的主方向距离」，不参与居中。
 * 3. **居中后再做边缘收敛**：只沿横跨轴 clamp（被夹住时允许相对图标轻微不对称），
 *    主方向放不下则返回 null，交给 Popover 的 flip 兜底，避免 clamp 后压住图标。
 * 4. 锚点/气泡尺寸为 0 或非有限值时返回 null，回退到 Popover 默认定位，不产生 NaN。
 */
export function computeTooltipPosition(
  anchor: TipRect,
  tip: TipRect,
  placement: Placement,
  offset: number,
  viewport: TipViewport,
  padding = VIEWPORT_PADDING,
): { left: number; top: number } | null {
  const finite = [
    anchor.left,
    anchor.top,
    anchor.width,
    anchor.height,
    tip.width,
    tip.height,
    viewport.width,
    viewport.height,
  ].every((n) => Number.isFinite(n));
  if (!finite || anchor.width <= 0 || anchor.height <= 0 || tip.width <= 0 || tip.height <= 0) {
    return null;
  }
  const dist = Number.isFinite(offset) ? Math.min(MAX_OFFSET, Math.max(0, offset)) : DEFAULT_OFFSET;
  const centerX = anchor.left + anchor.width / 2 - tip.width / 2;
  const centerY = anchor.top + anchor.height / 2 - tip.height / 2;

  let left = centerX;
  let top = centerY;
  if (placement === "top" || placement === "bottom") {
    left = centerX;
    top = placement === "top" ? anchor.top - dist - tip.height : anchor.top + anchor.height + dist;
    // 主方向放不下不 clamp（clamp 会压住图标），交给 flip 换边
    if (top < padding || top + tip.height > viewport.height - padding) return null;
  } else {
    top = centerY;
    left = placement === "left" ? anchor.left - dist - tip.width : anchor.left + anchor.width + dist;
    if (left < padding || left + tip.width > viewport.width - padding) return null;
  }

  // 居中后的横跨轴收敛：顺序不能反，否则先 clamp 再居中会再次偏移
  const maxLeft = Math.max(padding, viewport.width - tip.width - padding);
  const maxTop = Math.max(padding, viewport.height - tip.height - padding);
  return {
    left: Math.round(Math.min(maxLeft, Math.max(padding, left))),
    top: Math.round(Math.min(maxTop, Math.max(padding, top))),
  };
}

interface TipState {
  el: HTMLElement;
  text: string;
  /** 弹出方向：默认向上；被原生区域裁剪的锚点（胶囊轨道）用它把气泡指向可见区。 */
  placement: Placement;
  /** 与锚点的外扩距离（默认 6）：胶囊展开态用它把气泡推进面板可见区。 */
  offset: number;
}

export default function TooltipLayer() {
  const anchorRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const currentRef = useRef<HTMLElement | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  useEffect(() => {
    const find = (target: EventTarget | null): HTMLElement | null => {
      const el = target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
      return el && el.dataset.tip?.trim() ? el : null;
    };
    const clear = () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
    const hide = (delay = HIDE_DELAY) => {
      clear();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        currentRef.current = null;
        setTip(null);
      }, delay);
    };
    const show = (el: HTMLElement) => {
      const text = el.dataset.tip?.trim();
      if (!text) return;
      currentRef.current = el;
      anchorRef.current = el;
      setTip({ el, text, placement: readPlacement(el), offset: readOffset(el) });
    };

    const onOver = (e: MouseEvent) => {
      const el = find(e.target);
      if (!el) {
        hide();
        return;
      }
      if (currentRef.current === el) return;
      clear();
      timerRef.current = window.setTimeout(() => show(el), SHOW_DELAY);
    };
    const onOut = (e: MouseEvent) => {
      const from = find(e.target);
      const to = find(e.relatedTarget as EventTarget | null);
      if (from && from === to) return; // 只是在按钮内部移动
      hide();
    };
    // 键盘意图：只有 Tab 移动焦点才算「用户想键盘聚焦这个控件」。
    // 窗口重新激活时 Chromium 会对上次聚焦的按钮补发 focusin——点标题栏空白
    // 拖拽区触发的正是这条路径（`drag.js` 的 mousedown 会 preventDefault，
    // 焦点不离开按钮，原生 startDragging 激活窗口后 focusin 又被打回来），
    // 之前会把「最小化」提示弹在标题栏上。这里用输入模态把它过滤掉。
    let keyboardNav = false;
    const onPointerIntent = () => {
      keyboardNav = false;
      // 任何按下（点击控件、切页、刷新）立即移除提示，并取消尚未到点的悬停计时
      clear();
      if (currentRef.current) {
        currentRef.current = null;
        setTip(null);
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = find(e.target);
      if (!el) return;
      // 鼠标点击后的聚焦、窗口重新激活时的焦点恢复，都不是键盘导航
      if (!keyboardNav) return;
      keyboardNav = false; // 一次键盘导航只对应一次焦点移动
      clear();
      show(el);
    };
    const onFocusOut = () => hide(0);
    // 提示条不该挡住 Escape：它自己消失，但**不消费**按键，
    // 让弹层栈照常决定这一层 Escape 归谁。
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        keyboardNav = true;
        return;
      }
      if (e.key !== "Escape") return;
      clear();
      currentRef.current = null;
      setTip(null);
    };

    // 捕获阶段：标题栏拖拽区会在 mousedown 里 stopImmediatePropagation，
    // 先于它把指针意图记下来，避免「按下拖拽」被当成键盘聚焦。
    document.addEventListener("pointerdown", onPointerIntent, true);
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    // 挂在 window 的**冒泡**阶段：弹层栈的分发器在捕获阶段消费 Escape，
    // 那时提示条本来就该让位；这里只负责"没被消费时把提示条收起来"。
    window.addEventListener("keydown", onKey);
    return () => {
      clear();
      document.removeEventListener("pointerdown", onPointerIntent, true);
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // 显式居中定位：先把浮动层交回 Popover（floating-ui 负责首次渲染与尺寸变量），
  // 再按锚点/气泡实际矩形计算中心对齐 + 边界收敛；尺寸测不出时保持 null 回退。
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!tip) {
      setPosition(null);
      return;
    }
    let raf = 0;
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const host = floatingRef.current;
      if (!host) return;
      const anchor = tip.el.getBoundingClientRect();
      // 用 offsetWidth/Height（布局尺寸）而不是 getBoundingClientRect：
      // 入场动画对浮层做了 scale，首帧 rect 会偏小，按它居中会让最终位置偏移半条差值。
      const next = computeTooltipPosition(
        { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height },
        { left: 0, top: 0, width: host.offsetWidth, height: host.offsetHeight },
        tip.placement,
        tip.offset,
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPosition((prev) =>
        prev && next && prev.left === next.left && prev.top === next.top ? prev : next
      );
    };
    measure();
    // 尺寸变量（--popover-max-w）在首帧后才生效，下一帧复测一次，避免按旧宽度居中
    raf = window.requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      alive = false;
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [tip]);

  // 滚动时立即收起：提示跟随滚动会短暂压住新位置的卡片文字，直接移除更干净
  useEffect(() => {
    const onScroll = () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      currentRef.current = null;
      setTip(null);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, []);

  return (
    <Popover
      open={tip !== null}
      onOpenChange={(next) => {
        if (!next) setTip(null);
      }}
      anchorRef={anchorRef}
      floatingRef={floatingRef}
      positionOverride={position}
      placement={tip?.placement ?? "top"}
      layer={null}
      offsetPx={tip?.offset ?? DEFAULT_OFFSET}
      role="tooltip"
      className="ui-tooltip"
      restoreFocus={false}
      dismissOnOutsidePress={false}
      flipToSide={false}
    >
      {tip?.text ?? ""}
    </Popover>
  );
}
