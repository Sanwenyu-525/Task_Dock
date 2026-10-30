//! 全局控件提示层：**一个**实例承载全应用的控件提示。
//!
//! 为什么不做成「每个控件一个 Tooltip 组件」：应用里有上百个图标按钮，
//! 逐个挂浮层实例会带来上百个 Popover。这里改成**事件委托**——
//! 控件只声明 `data-tip="提示文案"`，由这一层统一监听 hover / focus，
//! 全局只渲染一个提示条。
//!
//! 约束：
//! - 不参与 Escape 弹层栈：它是瞬时提示，不该挡住「Esc 隐藏窗口」；
//! - `pointer-events: none`，不挡点击、不触发 outsidePress；
//! - 不抢焦点：关闭提示条时绝不把焦点夺回去（否则用户 Tab 走会被拽回原处）；
//! - 与原生 `title` 互斥：需要主题化提示的控件用 `data-tip`，
//!   纯文本截断提示（非交互元素）仍然保留原生 `title`。

import { useEffect, useRef, useState } from "react";
import Popover from "./Popover";

/** 悬停多久才出现：避免鼠标路过时闪一下。 */
const SHOW_DELAY = 350;
/** 移出多久才消失：允许鼠标从按钮移到提示条本身。 */
const HIDE_DELAY = 90;

interface TipState {
  el: HTMLElement;
  text: string;
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
      setTip({ el, text });
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
    const onFocusIn = (e: FocusEvent) => {
      const el = find(e.target);
      if (!el) return;
      clear();
      show(el);
    };
    const onFocusOut = () => hide(0);
    // 提示条不该挡住 Escape：它自己消失，但**不消费**按键，
    // 让弹层栈照常决定这一层 Escape 归谁。
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      clear();
      currentRef.current = null;
      setTip(null);
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    // 挂在 window 的**冒泡**阶段：弹层栈的分发器在捕获阶段消费 Escape，
    // 那时提示条本来就该让位；这里只负责"没被消费时把提示条收起来"。
    window.addEventListener("keydown", onKey);
    return () => {
      clear();
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
      placement="top"
      layer={null}
      offsetPx={6}
      role="tooltip"
      className="ui-tooltip"
      restoreFocus={false}
      dismissOnOutsidePress={false}
    >
      {tip?.text ?? ""}
    </Popover>
  );
}
