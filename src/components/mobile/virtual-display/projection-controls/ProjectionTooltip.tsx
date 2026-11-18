//! 投屏控制栏 Tooltip（任务六）。
//!
//! 渲染层：当前投屏窗口 WebView 内部的绝对定位层（React Portal 到容器根），
//! 不创建独立置顶窗口；层 `pointer-events: none`，永不拦截按钮点击。
//! 定位纯函数在边缘自动翻转并钳制进视口，容器/窗口圆角都不会裁切内容。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  TOOLTIP_HIDE_DELAY_MS,
  TOOLTIP_SHOW_DELAY_MS,
} from "./projection-sizes";

export type TooltipSide = "left" | "right" | "top" | "bottom";

export interface TooltipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TooltipSize {
  width: number;
  height: number;
}

/** 视口钳制边距：避开窗口圆角与 DWM 边框。 */
const VIEWPORT_MARGIN = 8;

/**
 * 视口边缘翻转：优先方向放不下（越出视口）就换到有空间的另一侧。
 * 仅几何判断，无副作用；测试直接覆盖窗口四角与边中点。
 */
export function resolveTooltipSide(
  triggerRect: TooltipRect,
  tooltipSize: TooltipSize,
  viewportRect: TooltipRect,
  preferredSide: TooltipSide = "left",
): TooltipSide {
  const fits = (side: TooltipSide): boolean => {
    switch (side) {
      case "left":
        return triggerRect.x - tooltipSize.width >= viewportRect.x + VIEWPORT_MARGIN;
      case "right":
        return (
          triggerRect.x + triggerRect.width + tooltipSize.width
          <= viewportRect.x + viewportRect.width - VIEWPORT_MARGIN
        );
      case "top":
        return triggerRect.y - tooltipSize.height >= viewportRect.y + VIEWPORT_MARGIN;
      case "bottom":
        return (
          triggerRect.y + triggerRect.height + tooltipSize.height
          <= viewportRect.y + viewportRect.height - VIEWPORT_MARGIN
        );
    }
  };
  const fallbacks: Record<TooltipSide, TooltipSide[]> = {
    left: ["right", "top", "bottom"],
    right: ["left", "top", "bottom"],
    top: ["bottom", "left", "right"],
    bottom: ["top", "left", "right"],
  };
  if (fits(preferredSide)) {
    return preferredSide;
  }
  for (const side of fallbacks[preferredSide]) {
    if (fits(side)) {
      return side;
    }
  }
  // 四面都放不下：仍返回优先方向，由 calculateTooltipPosition 钳制进视口。
  return preferredSide;
}

/**
 * 计算气泡位置（视口坐标）：沿 resolve 的方向贴住触发元素，并钳制进视口。
 * 气泡永不覆盖触发元素本身（side 定位天然不重叠）。
 */
export function calculateTooltipPosition(
  triggerRect: TooltipRect,
  tooltipSize: TooltipSize,
  viewportRect: TooltipRect,
  side: TooltipSide,
): { x: number; y: number } {
  const clampX = (x: number): number => {
    const min = viewportRect.x + VIEWPORT_MARGIN;
    const max = viewportRect.x + viewportRect.width - tooltipSize.width - VIEWPORT_MARGIN;
    // 气泡比视口还宽时钳制区间为空：贴住左边距（内容继续换行收缩）。
    if (min > max) {
      return min;
    }
    return Math.min(Math.max(x, min), max);
  };
  const clampY = (y: number): number => {
    const min = viewportRect.y + VIEWPORT_MARGIN;
    const max = viewportRect.y + viewportRect.height - tooltipSize.height - VIEWPORT_MARGIN;
    if (min > max) {
      return min;
    }
    return Math.min(Math.max(y, min), max);
  };
  const centerY = triggerRect.y + triggerRect.height / 2 - tooltipSize.height / 2;
  const centerX = triggerRect.x + triggerRect.width / 2 - tooltipSize.width / 2;
  let x: number;
  let y: number;
  switch (side) {
    case "left":
      x = triggerRect.x - tooltipSize.width;
      y = centerY;
      break;
    case "right":
      x = triggerRect.x + triggerRect.width;
      y = centerY;
      break;
    case "top":
      x = centerX;
      y = triggerRect.y - tooltipSize.height;
      break;
    case "bottom":
      x = centerX;
      y = triggerRect.y + triggerRect.height;
      break;
  }
  return { x: clampX(x), y: clampY(y) };
}

interface TooltipState {
  content: string;
  triggerRect: TooltipRect;
}

interface ProjectionTooltipContextValue {
  /** 鼠标进入/键盘聚焦按钮时调用；已有可见气泡时立即切换（快速滑过不闪烁）。 */
  showTooltip(content: string, triggerRect: TooltipRect): void;
  /** 鼠标离开/失焦：调度隐藏（隐藏延迟内移到别的按钮会被 show 取消）。 */
  hideTooltip(): void;
  cancelTooltipHide(): void;
}

const ProjectionTooltipContext = createContext<ProjectionTooltipContextValue | null>(null);

export function useProjectionTooltip(): ProjectionTooltipContextValue {
  const ctx = useContext(ProjectionTooltipContext);
  if (!ctx) {
    throw new Error("useProjectionTooltip 必须在 ProjectionTooltipLayer 内使用");
  }
  return ctx;
}

interface ProjectionTooltipLayerProps {
  /** 视口（WebView 客户区）尺寸；由布局 Hook 传入，窗口 resize 时更新。 */
  viewportWidth: number;
  viewportHeight: number;
  /** 布局模式决定优先方向：Side/Compact 列在右缘 → 向左；Bottom 条在底部 → 向上。 */
  layoutMode: "side" | "bottom" | "compact";
  children: ReactNode;
}

/**
 * Tooltip 层 + 提供者。显示/隐藏各只有一个定时器（可取消），
 * 快速经过多个按钮时：已可见 → 立即切换内容；未可见 → 350ms 显示延迟。
 */
export function ProjectionTooltipLayer({
  viewportWidth,
  viewportHeight,
  layoutMode,
  children,
}: ProjectionTooltipLayerProps) {
  const [state, setState] = useState<TooltipState | null>(null);
  const [visible, setVisible] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef<TooltipState | null>(null);
  stateRef.current = state;

  const clearTimers = useCallback(() => {
    if (showTimer.current !== null) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const showTooltip = useCallback(
    (content: string, triggerRect: TooltipRect) => {
      clearTimers();
      if (stateRef.current && visible) {
        // 已经可见：直接切换（快速滑过不闪烁、不重新延迟）。
        setState({ content, triggerRect });
        return;
      }
      showTimer.current = setTimeout(() => {
        showTimer.current = null;
        setState({ content, triggerRect });
        setVisible(true);
      }, TOOLTIP_SHOW_DELAY_MS);
    },
    [clearTimers, visible],
  );

  const hideTooltip = useCallback(() => {
    clearTimers();
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setVisible(false);
      setState(null);
    }, TOOLTIP_HIDE_DELAY_MS);
  }, [clearTimers]);

  const cancelTooltipHide = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, [clearTimers]);

  const contextValue = useMemo<ProjectionTooltipContextValue>(
    () => ({ showTooltip, hideTooltip, cancelTooltipHide }),
    [showTooltip, hideTooltip, cancelTooltipHide],
  );

  const viewport: TooltipRect = { x: 0, y: 0, width: viewportWidth, height: viewportHeight };
  const preferredSide: TooltipSide = layoutMode === "bottom" ? "top" : "left";

  // 气泡实际尺寸：宽度对齐「导航列 + Tooltip 溢出区」预算（NAV_COLUMN+PAD=192，
  // 减两侧边距），长文本自动换行；渲染后由 CSS 自适应，此处用于定位钳制。
  const bubbleWidth = 100;
  const bubbleHeight = 30;
  const position = state
    ? calculateTooltipPosition(
        state.triggerRect,
        { width: bubbleWidth, height: bubbleHeight },
        viewport,
        resolveTooltipSide(
          state.triggerRect,
          { width: bubbleWidth, height: bubbleHeight },
          viewport,
          preferredSide,
        ),
      )
    : null;

  return (
    <ProjectionTooltipContext.Provider value={contextValue}>
      {children}
      {state && visible && position ? (
        <div
          className="projection-tooltip"
          role="tooltip"
          style={{ left: position.x, top: position.y, width: bubbleWidth }}
        >
          {state.content}
        </div>
      ) : null}
    </ProjectionTooltipContext.Provider>
  );
}

/** 触发器：把 hover/focus 事件换算成触发矩形并上报（disabled 按钮同样生效）。 */
export function ProjectionTooltipTrigger({
  content,
  children,
  disabled = false,
}: {
  content: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const { showTooltip, hideTooltip, cancelTooltipHide } = useProjectionTooltip();
  const report = useCallback(
    (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      showTooltip(content, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    },
    [content, showTooltip],
  );
  return (
    <span
      className="projection-tooltip-trigger"
      style={{ display: "inline-flex" }}
      onMouseEnter={(event) => report(event.currentTarget)}
      onMouseLeave={hideTooltip}
      onFocus={(event) => {
        cancelTooltipHide();
        report(event.currentTarget);
      }}
      onBlur={hideTooltip}
      aria-disabled={disabled || undefined}
    >
      {children}
    </span>
  );
}
