//! 指针右键菜单基元：以鼠标坐标（而不是元素）为锚点的弹层。
//!
//! 与 `Popover` 的分工：
//! - `Popover` 的 reference 是一个真实元素，位置交给 floating-ui；
//! - 右键菜单只有一对坐标，没有可测量的锚点，因此由 `positioning.ts` 的
//!   `resolvePointerMenuPosition` 计算最终坐标：默认从指针右下展开，
//!   右/下空间不足向左/上翻转，最后四边夹取。
//!
//! 本组件只负责「定位 + Portal + 弹层栈 + 外部点击 + 焦点陷阱」。菜单项长什么样、
//! 有哪些动作、危险色与禁用态，全部由调用方渲染（保留各业务菜单的视觉差异）。
//!
//! 定位在 layout effect 里同步完成：元素先以指针坐标渲染，测量后在同一帧写入
//! 收敛坐标，因此不会出现「先出现在越界位置、下一帧再跳回来」的闪烁。

import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useFocusTrap, useOverlayLayer } from "./overlay";
import {
  DEFAULT_COLLISION_PADDING,
  resolvePointerMenuPosition,
} from "./positioning";

export interface PointerMenuProps {
  open: boolean;
  /** 指针位置（clientX/clientY） */
  x: number;
  y: number;
  /** 菜单可访问名 */
  label: string;
  onClose: () => void;
  /** 业务视觉类名（`shelf-context-menu` / `rc-ctx-menu` / `fw-divider-menu`） */
  className?: string;
  /** 内容最小宽度；实际宽度由内容决定，但不会超出可用窗口 */
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** 是否把焦点移进菜单并在其中循环 Tab（右键菜单默认 true；
   *  分割线比例菜单必须 false：焦点要留在分割线，方向键继续调比例） */
  trapFocus?: boolean;
  /** 业务键盘处理（方向键在菜单项间移动由基元接管，其余按键透传） */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

export default function PointerMenu({
  open,
  x,
  y,
  label,
  onClose,
  className,
  minWidth,
  maxWidth,
  maxHeight,
  trapFocus = true,
  onKeyDown,
  children,
}: PointerMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useOverlayLayer("menu", open, onClose, ref);
  useFocusTrap(open && trapFocus, ref);

  // 点击菜单外部关闭；菜单内部点击由业务按钮自行处理。
  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, onClose]);

  // 测量 → 纯函数定位；内容尺寸变化（禁用项、字体加载、异步项）后重新收敛。
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const next = resolvePointerMenuPosition(
        { x, y },
        { width: rect.width, height: rect.height },
        viewport,
        DEFAULT_COLLISION_PADDING,
      );
      setPos((prev) =>
        prev.left === next.left && prev.top === next.top ? prev : { left: next.left, top: next.top },
      );
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open, x, y]);

  if (!open) return null;

  const moveFocus = (direction: 1 | -1 | "first" | "last") => {
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      direction === "first"
        ? 0
        : direction === "last"
          ? buttons.length - 1
          : (current + direction + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      className={`ui-pointer-menu ${className ?? ""}`}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{
        left: pos.left,
        top: pos.top,
        minWidth,
        ...(maxWidth !== undefined ? { maxWidth } : null),
        ...(maxHeight !== undefined ? { maxHeight } : null),
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveFocus(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(-1);
        } else if (event.key === "Home") {
          event.preventDefault();
          moveFocus("first");
        } else if (event.key === "End") {
          event.preventDefault();
          moveFocus("last");
        }
        onKeyDown?.(event);
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
