//! 页面级工作区分栏：左侧导航/筛选 + 主工作区。
//!
//! 大型工作台不是把旧面板整体拉宽。页面需要把「导航/筛选」从顶部工具条
//! 提升为独立区域，让主工作区获得稳定的横向空间；右栏仍由工作台外壳统一
//! 承担，避免每页重复实现第二套检查器。
//!
//! 本组件只负责布局与宽度记忆，不持有业务状态：
//! - 宽度经指针拖动或键盘调整，写入 localStorage（WebView 独立持久化）；
//! - 拖拽期间只更新临时宽度（setState），pointerup / pointercancel /
//!   blur / 页面隐藏才提交最终值——不在每次 pointermove 同步写 localStorage；
//! - 最小/最大宽度按页面传入，避免侧栏压垮主区；
//! - 容器宽度不足时自动降级为上下分区，侧栏仍可滚动，不隐藏筛选能力。
//!
//! 2026-11-16：查询容器移到外层 `.workspace-split-frame`。容器查询只能让
//! 容器**的后代**响应它的尺寸，此前 `.workspace-split` 查询自身属于自引用，
//! 窄容器规则永远不会命中（详见 workspaceSplit.css 头部说明）。
//!
//! 2026-11-21：拖拽改为显式会话（beginResize → finish）。会话持有唯一
//! pointerId 与幂等 cleanup：pointerup / pointercancel / window blur /
//! visibilitychange(hidden) / 组件卸载都会终止会话并移除全部 window 监听
//! 与 body 拖拽态；卸载路径不执行持久化（组件已不在）。

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

/** 一次指针拖拽会话：pointermove 只改草稿，终止时统一清理。 */
interface ResizeSession {
  pointerId: number;
  /** 会话已终止标记：保证 cleanup 幂等，二次调用不再移除/持久化。 */
  done: boolean;
  /** 幂等清理：移除全部 window/document 监听与 body 拖拽态。 */
  cleanup: () => void;
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
  const frameRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ResizeSession | null>(null);
  const [width, setWidth] = useState(() => readWidth(id, defaultWidth, minWidth, maxWidth));
  const sidebarId = `${useId()}-sidebar`;

  useEffect(() => {
    setWidth(readWidth(id, defaultWidth, minWidth, maxWidth));
  }, [id, defaultWidth, minWidth, maxWidth]);

  const clampWidth = useCallback(
    (next: number) => Math.min(maxWidth, Math.max(minWidth, Math.round(next))),
    [minWidth, maxWidth],
  );

  /** 拖拽期临时宽度：只更新视觉（setState），不写 localStorage。 */
  const updateDraftWidth = useCallback(
    (next: number) => setWidth(clampWidth(next)),
    [clampWidth],
  );

  /** 键盘/双击等离散调整：低频动作，调整即持久化。 */
  const commitWidth = useCallback(
    (next: number) => {
      const clamped = clampWidth(next);
      setWidth(clamped);
      persistWidth(id, clamped);
    },
    [id, clampWidth],
  );

  // 组件卸载即放弃会话：清理监听与拖拽态，不执行持久化（组件已不在）。
  useEffect(
    () => () => {
      sessionRef.current?.cleanup();
    },
    [],
  );

  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !frameRef.current) return;
      // 已有活跃会话（理论不可能：同一分隔条不会并发 pointerdown）：
      // 忽略新的按下，新旧会话互不影响。
      if (sessionRef.current) return;
      event.preventDefault();
      // 以查询容器的左边界测量：frame 与 grid 同宽同起点，命中区只在其内部列中。
      const rect = frameRef.current.getBoundingClientRect();
      const pointerId = event.pointerId;
      let draft = clampWidth(width);

      const finish = (persist: boolean) => {
        const session = sessionRef.current;
        if (!session || session.done) return;
        session.done = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onBlur);
        document.removeEventListener("visibilitychange", onVisibility);
        document.body.classList.remove("workspace-split-resizing");
        sessionRef.current = null;
        if (persist) persistWidth(id, draft);
      };
      const onMove = (moveEvent: globalThis.PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        draft = clampWidth(moveEvent.clientX - rect.left);
        updateDraftWidth(draft);
      };
      const onUp = (upEvent: globalThis.PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        finish(true);
      };
      const onCancel = (cancelEvent: globalThis.PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return;
        // 系统接管（触摸取消等）打断拖拽：提交当前草稿，与屏幕上的最终
        // 视觉保持一致，不跳回拖前宽度。
        finish(true);
      };
      const onBlur = () => finish(true);
      const onVisibility = () => {
        if (document.visibilityState === "hidden") finish(true);
      };

      sessionRef.current = {
        pointerId,
        done: false,
        cleanup: () => finish(false),
      };
      document.body.classList.add("workspace-split-resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onBlur);
      document.addEventListener("visibilitychange", onVisibility);
    },
    [id, clampWidth, updateDraftWidth, width],
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
      <div
        className="workspace-split-frame"
        ref={frameRef}
        data-workspace-split={id}
      >
        <div className="workspace-split is-single" style={style}>
          <div className="workspace-split__main">{children}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="workspace-split-frame"
      ref={frameRef}
      data-workspace-split={id}
    >
      <div className="workspace-split" style={style}>
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
    </div>
  );
}
