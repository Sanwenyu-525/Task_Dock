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
  /** 主方向放不下时是否允许翻到垂直侧边（默认 true）。
   *  提示条必须为 false：翻到侧边会把气泡放到锚点左侧/右侧之外，
   *  在胶囊这种 Win32 区域裁剪窗口里会被裁成一条白色碎片。 */
  flipToSide?: boolean;
  /** 显式定位覆盖（提示条用）：给出 left/top 时覆盖 floating-ui 写位，仍保留其
   *  初始定位作为「尺寸未测出」时的安全回退；居中与边界收敛由调用方纯函数计算。 */
  positionOverride?: { left: number; top: number } | null;
  /** 暴露定位外壳元素，供调用方测量气泡实际尺寸（避免把尺寸写死成魔法数）。 */
  floatingRef?: RefObject<HTMLDivElement | null>;
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
  flipToSide = true,
  positionOverride = null,
  floatingRef,
}: PopoverProps) {
  const generatedId = useId();

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    placement,
    strategy: "fixed",
    whileElementsMounted(reference, floating, update) {
      // 显式定位（提示条）由调用方计算并随滚动/窗口尺寸复测；此时关掉
      // autoUpdate，避免它把 floating-ui 的坐标写回并覆盖 override。
      if (positionOverride) return () => {};
      return autoUpdate(reference, floating, update, {
        ancestorScroll: true,
        ancestorResize: true,
        elementResize: typeof ResizeObserver !== "undefined",
      });
    },
    middleware: [
      offset(offsetPx),
      flip({ padding: 8, fallbackAxisSideDirection: flipToSide ? "start" : "none" }),
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

  // 显式定位优先：transform 归零，left/top 直接写最终坐标，避免与 floating-ui
  // 的 translate 叠加产生二次偏移。
  const hostStyle: CSSProperties = positionOverride
    ? {
        ...floatingStyles,
        left: `${positionOverride.left}px`,
        top: `${positionOverride.top}px`,
        transform: "none",
      }
    : floatingStyles;

  const content = (
    // 外壳只负责定位（floating-ui 会写 transform），内层负责动效，
    // 两者分开才不会让入场动画覆盖掉定位变换。
    <div
      ref={(el) => {
        refs.setFloating(el);
        if (floatingRef) floatingRef.current = el;
      }}
      className="ui-popover-host"
      style={hostStyle}
      {...getFloatingProps()}
    >
      <div
        className={`ui-popover ${className ?? ""}`}
        style={style}
        id={id ?? generatedId}
        role={role}
        aria-label={ariaLabel}
        data-placement={positionOverride ? placement : context?.placement}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
