//! 页面级工作区分栏：左侧导航/筛选 + 主工作区。
//!
//! 大型工作台不是把旧面板整体拉宽。页面需要把「导航/筛选」从顶部工具条
//! 提升为独立区域，让主工作区获得稳定的横向空间；右栏仍由工作台外壳统一
//! 承担，避免每页重复实现第二套检查器。
//!
//! 本组件只负责布局与宽度记忆，不持有业务状态：
//! - 宽度经指针拖动或键盘调整，写入 localStorage（WebView 独立持久化）；
//! - 最小/最大宽度按页面传入，避免侧栏压垮主区；
//! - 容器宽度不足时自动降级为上下分区，侧栏仍可滚动，不隐藏筛选能力。

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { GripVertical } from "lucide-react";
import "./workspaceSplit.css";

const STORAGE_PREFIX = "taskdock.workspace.split.";
const RESIZE_STEP = 8;

function storageKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

function readWidth(id: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    const value = raw ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  } catch {
    return fallback;
  }
}

function persistWidth(id: string, width: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(id), String(Math.round(width)));
  } catch {
    // 隐私模式/配额失败只影响记忆，不应阻断布局使用。
  }
}

export interface WorkspaceSplitProps {
  /** 稳定的页面标识；用于布局持久化，不使用标题文案。 */
  id: string;
  /** 左侧导航/筛选区域；为 null 时主区占满。 */
  sidebar: ReactNode | null;
  /** 侧栏的无障碍名称。 */
  sidebarLabel: string;
  children: ReactNode;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
}

export default function WorkspaceSplit({
  id,
  sidebar,
  sidebarLabel,
  children,
  defaultWidth = 236,
  minWidth = 200,
  maxWidth = 340,
}: WorkspaceSplitProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => readWidth(id, defaultWidth, minWidth, maxWidth));
  const sidebarId = `${useId()}-sidebar`;

  useEffect(() => {
    setWidth(readWidth(id, defaultWidth, minWidth, maxWidth));
  }, [id, defaultWidth, minWidth, maxWidth]);

  const commitWidth = useCallback(
    (next: number) => {
      const clamped = Math.min(maxWidth, Math.max(minWidth, Math.round(next)));
      setWidth(clamped);
      persistWidth(id, clamped);
    },
    [id, minWidth, maxWidth],
  );

  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !rootRef.current) return;
      event.preventDefault();
      const rect = rootRef.current.getBoundingClientRect();
      const pointerId = event.pointerId;

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        commitWidth(moveEvent.clientX - rect.left);
      };
      const onUp = (upEvent: globalThis.PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        document.body.classList.remove("workspace-split-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      document.body.classList.add("workspace-split-resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [commitWidth],
  );

  const onResizerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      commitWidth(width - RESIZE_STEP);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      commitWidth(width + RESIZE_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      commitWidth(minWidth);
    } else if (event.key === "End") {
      event.preventDefault();
      commitWidth(maxWidth);
    } else if (event.key === "Enter") {
      event.preventDefault();
      commitWidth(defaultWidth);
    }
  };

  const style = {
    "--workspace-split-sidebar": `${width}px`,
  } as CSSProperties;

  if (!sidebar) {
    return (
      <div className="workspace-split is-single" ref={rootRef} style={style}>
        <div className="workspace-split__main">{children}</div>
      </div>
    );
  }

  return (
    <div className="workspace-split" ref={rootRef} style={style}>
      <aside className="workspace-split__sidebar" id={sidebarId} aria-label={sidebarLabel}>
        {sidebar}
      </aside>
      <div
        className="workspace-split__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={`调整${sidebarLabel}宽度`}
        aria-controls={sidebarId}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={onResizerKeyDown}
        onDoubleClick={() => commitWidth(defaultWidth)}
        data-tip="拖动调整宽度；方向键微调，双击恢复默认"
      >
        <GripVertical size={13} aria-hidden="true" />
      </div>
      <section className="workspace-split__main">{children}</section>
    </div>
  );
}
