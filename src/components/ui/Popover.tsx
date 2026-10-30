//! 锚定式弹层：定位、翻转、边界收敛、外部点击关闭、Escape 交给全局弹层栈。
//!
//! 定位交给 floating-ui（只做定位这一件事，不引入整套 UI 框架）：
//! - flip：底部空间不足时向上弹出；
//! - shift：窄窗口内沿轴向平移，不溢出窗口边界；
//! - size：把可用高度写进 CSS 变量，长列表在浮层内滚动而不是撑出窗口。

import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  type Placement,
} from "@floating-ui/react";
import {
  useId,
  useLayoutEffect,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { OverlayKind } from "../../lib/overlayStack";
import { useFocusRestore, useOverlayLayer } from "./overlay";

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  placement?: Placement;
  className?: string;
  /** 注册到弹层栈的层级，决定 Escape 优先级；null = 不参与（提示条等瞬时层） */
  layer?: OverlayKind | null;
  /** 浮层最小宽度跟随锚点 */
  matchWidth?: boolean;
  offsetPx?: number;
  role?: string;
  ariaLabel?: string;
  id?: string;
  style?: CSSProperties;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  /** 关闭时是否把焦点还给触发元素（提示条必须为 false，否则会抢焦点） */
  restoreFocus?: boolean;
  /** 点击浮层外部是否关闭（提示条必须为 false：它不接收指针事件） */
  dismissOnOutsidePress?: boolean;
}

export default function Popover({
  open,
  onOpenChange,
  anchorRef,
  children,
  placement = "bottom-start",
  className,
  layer = "menu",
  matchWidth = false,
  offsetPx = 6,
  role,
  ariaLabel,
  id,
  style,
  onKeyDown,
  restoreFocus = true,
  dismissOnOutsidePress = true,
}: PopoverProps) {
  const generatedId = useId();

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    placement,
    strategy: "fixed",
    whileElementsMounted(reference, floating, update) {
      return autoUpdate(reference, floating, update, {
        ancestorScroll: true,
        ancestorResize: true,
        elementResize: typeof ResizeObserver !== "undefined",
      });
    },
    middleware: [
      offset(offsetPx),
      flip({ padding: 8, fallbackAxisSideDirection: "start" }),
      shift({ padding: 8, crossAxis: true }),
      size({
        padding: 8,
        apply({ availableHeight, availableWidth, elements }) {
          const el = elements.floating;
          el.style.setProperty("--popover-max-h", `${Math.max(120, Math.floor(availableHeight))}px`);
          el.style.setProperty("--popover-max-w", `${Math.max(140, Math.floor(availableWidth))}px`);
          if (matchWidth) {
            const w = elements.reference.getBoundingClientRect().width;
            if (w > 0) el.style.setProperty("--popover-min-w", `${Math.round(w)}px`);
          }
        },
      }),
    ],
  });

  // 锚点由调用方持有，这里把元素交给 floating-ui 参与定位
  useLayoutEffect(() => {
    if (anchorRef.current) refs.setReference(anchorRef.current);
  });

  const { getFloatingProps } = useInteractions([
    useDismiss(context, {
      // Escape 由全局弹层栈统一分发（见 lib/overlayStack），这里关掉避免双重消费
      escapeKey: false,
      referencePress: false,
      outsidePress: (event) =>
        dismissOnOutsidePress && !anchorRef.current?.contains(event.target as Node),
    }),
  ]);

  // 关闭后焦点回到触发它的元素
  useFocusRestore(open && restoreFocus);

  // Escape 只关闭本层；栈顶还有更上层时本层不会被命中
  useOverlayLayer(layer ?? "menu", layer !== null && open, () => onOpenChange(false));

  if (!open) return null;

  const content = (
    // 外壳只负责定位（floating-ui 会写 transform），内层负责动效，
    // 两者分开才不会让入场动画覆盖掉定位变换。
    <div
      ref={refs.setFloating}
      className="ui-popover-host"
      style={floatingStyles}
      {...getFloatingProps()}
    >
      <div
        className={`ui-popover ${className ?? ""}`}
        style={style}
        id={id ?? generatedId}
        role={role}
        aria-label={ariaLabel}
        data-placement={context?.placement}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
