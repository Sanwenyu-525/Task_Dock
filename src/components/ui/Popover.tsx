//! 锚定式弹层：定位、翻转、边界收敛、外部点击关闭、Escape 交给全局弹层栈。
//!
//! 定位交给 floating-ui（只做定位这一件事，不引入整套 UI 框架），策略由本组件统一解析：
//! - `side` + `alignment`：不写完整 placement 字符串也能声明意图；`auto` 允许
//!   在 start/end 之间按空间切换（flipAlignment），显式对齐只翻转主方向、
//!   横向越界交给 shift 收敛，保持设计指定的对齐关系；
//! - `collisionPadding`：窗口边缘留白（默认 8）；
//! - `minWidth/maxWidth/maxHeight`：尺寸约束统一经 `positioning.ts` 计算，
//!   min 不会压过 max（极窄窗口不越界优先）；
//! - `flip`：主方向空间不足时翻转；`shift`：窄窗口内沿轴向平移；
//! - `size`：把可用高/宽写进 CSS 变量，长列表在浮层内滚动而不是撑出窗口。
//!
//! 定位生命周期只有一份：`whileElementsMounted(autoUpdate)` 同时监听窗口尺寸、
//! 祖先滚动、锚点与弹层尺寸。调用方不再需要自己写 resize/scroll 监听。

import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
  type Placement,
} from "@floating-ui/react";
import {
  useId,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { OverlayKind } from "../../lib/overlayStack";
import { findOverlayPortal, useFocusRestore, useOverlayLayer } from "./overlay";
import {
  constrainPopupSize,
  parsePlacement,
  resolvePopupConfig,
  toFloatingPlacement,
  type PopupAlignment,
  type PopupSide,
} from "./positioning";

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  /** 完整 placement 字符串（旧接口，仍然优先于组件默认值；被 side/alignment 覆盖） */
  placement?: Placement;
  /** 首选主方向；提供后覆盖 placement 的主方向 */
  side?: PopupSide;
  /** 首选对齐；`auto` = 允许 start/end 按可用空间切换 */
  alignment?: PopupAlignment;
  className?: string;
  /** 注册到弹层栈的层级，决定 Escape 优先级；null = 不参与（提示条等瞬时层） */
  layer?: OverlayKind | null;
  /** 浮层最小宽度跟随锚点 */
  matchWidth?: boolean;
  offsetPx?: number;
  /** 与窗口边缘的最小留白（默认 8） */
  collisionPadding?: number;
  /** 尺寸约束：min 会被收到 max 以内，绝不为满足最小宽度而越界 */
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** 主方向放不下时是否允许翻转到对侧（默认 true） */
  allowFlip?: boolean;
  /** 是否允许 start/end 自动切换；默认仅 alignment="auto" 时开启 */
  allowAlignmentFlip?: boolean;
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
  side,
  alignment,
  className,
  layer = "menu",
  matchWidth = false,
  offsetPx = 6,
  collisionPadding = 8,
  minWidth,
  maxWidth,
  maxHeight,
  allowFlip = true,
  allowAlignmentFlip,
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
  // 外壳节点同时作为弹层栈的 DOM 根：锚点在对话框内时它会被挂进遮罩，
  // 由此可判定「菜单在对话框内部」，Escape 才能先关菜单再关对话框。
  const hostRef = useRef<HTMLDivElement | null>(null);

  const config = useMemo(
    () => ({
      offset: offsetPx,
      collisionPadding,
      matchAnchorWidth: matchWidth,
      minWidth,
      maxWidth,
      maxHeight,
      allowFlip,
    }),
    [offsetPx, collisionPadding, matchWidth, minWidth, maxWidth, maxHeight, allowFlip],
  );

  // 显式 side/alignment 优先；否则拆解 placement。center 在 floating-ui 里是裸 side。
  const resolved = resolvePopupConfig({ placement, side, alignment });
  // auto 以 start 为基准，交给 flipAlignment 在实测尺寸后切换；其余原样映射。
  const baseAlignment = resolved.alignment === "auto" ? "start" : resolved.alignment;
  const floatingPlacement = toFloatingPlacement(resolved.side, baseAlignment) as Placement;
  const parsedPlacement = parsePlacement(placement);
  const alignmentFlip =
    allowAlignmentFlip ?? (alignment ?? parsedPlacement.alignment) === "auto";

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    placement: floatingPlacement,
    strategy: "fixed",
    whileElementsMounted(reference, floating, update) {
      // 显式定位（提示条）由调用方计算并随滚动/窗口尺寸复测；此时关掉
      // autoUpdate，避免它把 floating-ui 的坐标写回并覆盖 override。
      if (positionOverride) return () => {};
      return autoUpdate(reference, floating, update, {
        ancestorScroll: true,
        ancestorResize: true,
        elementResize: typeof ResizeObserver !== "undefined",
        layoutShift: true,
      });
    },
    middleware: [
      offset(offsetPx),
      ...(allowFlip
        ? [
            flip({
              padding: collisionPadding,
              // auto：允许 start/end 按可用空间切换；显式对齐：只翻主方向，
              // 横向越界交给 shift 内收，避免把设计指定的右对齐改成左对齐。
              flipAlignment: alignmentFlip,
              fallbackAxisSideDirection: flipToSide ? "start" : "none",
            }),
          ]
        : []),
      shift({ padding: collisionPadding, crossAxis: true }),
      size({
        padding: collisionPadding,
        apply({ availableWidth, availableHeight, elements }) {
          const el = elements.floating;
          const limits = constrainPopupSize({
            anchorWidth: elements.reference.getBoundingClientRect().width,
            availableWidth,
            availableHeight,
            config,
          });
          el.style.setProperty("--popover-max-h", `${Math.max(0, limits.maxHeight)}px`);
          el.style.setProperty("--popover-max-w", `${Math.max(0, limits.maxWidth)}px`);
          // 最小宽度也参与「不得超过可用宽」：CSS 的 min-width 会压过 max-width，
          // 因此这里写入的一定是已收敛到 max 以内的值。
          el.style.setProperty("--popover-min-w", `${Math.max(0, limits.minWidth)}px`);
          if (maxWidth !== undefined) {
            el.style.setProperty("--popover-width-cap", `${Math.max(0, maxWidth)}px`);
          }
          // 可观测性：测试与排障可读最终尺寸上限，不必反推 CSS。
          el.dataset.popupMaxWidth = String(limits.maxWidth);
          el.dataset.popupMaxHeight = String(limits.maxHeight);
        },
      }),
    ],
  });

  // 锚点由调用方持有，这里把元素交给 floating-ui 参与定位
  useLayoutEffect(() => {
    if (anchorRef.current) refs.setReference(anchorRef.current);
  });

  // 外部点击 / 外部滚动 / 窗口失焦统一关闭本层。
  // 用捕获阶段监听，避免设置行、折叠头等 React 处理器调用 stopPropagation 后
  // 文档级监听收不到事件；浮层本身与触发按钮内的交互不关闭。
  useEffect(() => {
    if (!open || !dismissOnOutsidePress) return;
    const isInside = (target: EventTarget | null) =>
      !!target &&
      ((hostRef.current?.contains(target as Node) ?? false) ||
        (anchorRef.current?.contains(target as Node) ?? false));
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event.target)) onOpenChange(false);
    };
    // 捕获阶段能拿到不冒泡的滚动事件；浮层内部列表滚动不关闭。
    const onScroll = (event: Event) => {
      if (!isInside(event.target)) onOpenChange(false);
    };
    // 点击落在 WebView 之外时页面收不到指针事件，只能靠窗口失焦兜底。
    const onBlur = () => onOpenChange(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, dismissOnOutsidePress, onOpenChange, anchorRef]);

  // 关闭后焦点回到触发它的元素
  useFocusRestore(open && restoreFocus);

  // Escape 只关闭本层；栈顶还有更上层时本层不会被命中
  useOverlayLayer(layer ?? "menu", layer !== null && open, () => onOpenChange(false), hostRef);

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

  // 实际落点：override 时调用方已算好 side，取 placement 的主方向；
  // 否则用 floating-ui 最终 placement（翻转后的真实方向）。
  const actualPlacement = positionOverride ? floatingPlacement : context?.placement;
  const flipped =
    context?.middlewareData?.flip?.index !== undefined && context.middlewareData.flip.index > 0;

  const content = (
    // 外壳只负责定位（floating-ui 会写 transform），内层负责动效，
    // 两者分开才不会让入场动画覆盖掉定位变换。
    <div
      ref={(el) => {
        hostRef.current = el;
        refs.setFloating(el);
        if (floatingRef) floatingRef.current = el;
      }}
      className="ui-popover-host"
      style={hostStyle}
      data-popup-flipped={flipped ? "true" : undefined}
    >
      <div
        className={`ui-popover ${className ?? ""}`}
        style={style}
        id={id ?? generatedId}
        role={role}
        aria-label={ariaLabel}
        data-placement={actualPlacement}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );

  // 锚点在对话框内时挂进该对话框的遮罩层（与该对话框同一层叠上下文），
  // 否则弹层外壳的 --z-menu(900) 会整块压在 --z-dialog(940) 的遮罩之下。
  return createPortal(content, findOverlayPortal(anchorRef.current) ?? document.body);
}
