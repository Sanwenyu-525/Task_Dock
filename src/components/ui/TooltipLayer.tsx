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

import { useEffect, useRef, useState } from "react";
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

  return (
    <Popover
      open={tip !== null}
      onOpenChange={(next) => {
        if (!next) setTip(null);
      }}
      anchorRef={anchorRef}
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
