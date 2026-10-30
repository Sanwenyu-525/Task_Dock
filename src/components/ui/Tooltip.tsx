//! 控件提示（Tooltip）：悬停或键盘聚焦时出现，离开即消失。
//!
//! 不参与 Escape 弹层栈——它是瞬时提示，不该挡住「Esc 隐藏窗口」。

import { useRef, useState, type ReactNode } from "react";
import type { Placement } from "@floating-ui/react";
import Popover from "./Popover";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  placement?: Placement;
  /** 触发元素 */
  as?: "span" | "div";
  className?: string;
}

export default function Tooltip({ content, children, placement = "top", as = "span", className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement>(null);
  const Tag = as;

  if (!content) return <>{children}</>;

  return (
    <>
      <Tag
        ref={anchorRef as never}
        className={`ui-tooltip-anchor ${className ?? ""}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocusCapture={() => setOpen(true)}
        onBlurCapture={() => setOpen(false)}
      >
        {children}
      </Tag>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement={placement}
        offsetPx={6}
        layer={null}
        className="ui-tooltip"
        role="tooltip"
      >
        {content}
      </Popover>
    </>
  );
}
