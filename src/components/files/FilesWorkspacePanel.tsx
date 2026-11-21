//! 文件工作区主面板：顶部工具栏 + 递归分割树渲染 + 布局抽屉 + 协作接入。
//!
//! 架构边界（任务规范 Phase 0 方案）：
//! - 复用工作台 Shell（WorkbenchShell 路由槽），不造第二套窗口/导航；
//! - 树形状与窗格状态在 `useFilesWorkspaceStore`；目录数据在 `dirCache`；
//! - 持久化经 `filesWorkspace/persist.ts` 写独立设置键，不写 workbench_layout /
//!   workspace_instances.layout_json；
//! - 外部 OS 拖入经 fileDrop 仲裁认领（priority 20 > 暂存架 10），只接受本地
//!   文件路径并以「复制」语义投递到命中的分栏——外部来源默认不删用户源文件；
//! - Agent/其他模块入口：`openFilesWorkspacePath`（本文件导出）显式打开目录。

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Columns2,
  FolderPlus,
  FolderTree,
  LayoutGrid,
  LayoutPanelTop,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Plus,
  Rows2,
  Save,
  Square,
  Columns3,
  FolderOpen,
  FolderSearch,
  Search,
  Files,
  Pin,
  PinOff,
  Redo2,
  Undo2,
  PenLine,
  Check,
  AlertTriangle,
  ChevronDown,
  Copy,
  Move,
  Scissors,
  Trash2,
  Archive,
} from "lucide-react";

import DropdownMenu, { type DropdownMenuItem } from "../ui/DropdownMenu";
import PointerMenu from "../ui/PointerMenu";
import { centerPopupInViewport } from "../ui/positioning";
import { ConfirmDialog, Dialog } from "../ui/Dialog";
import Popover from "../ui/Popover";
import "./files.css";
import { useLocale } from "../../hooks/useLocale";
import { errorMessage } from "../../lib/errors";
import { isLogged, startOperation, startTracedOperation } from "../../lib/diagnostics";
import { showFileJobOutcome, showFsOpOutcome } from "./fsOpFeedback";
import {
  fsCopyJobStart,
  fsDragOut,
  fsMoveJobStart,
  fsDeleteJobStart,
  fsDeleteVerifiedDuplicates,
  fsPlaces,
  fsStat,
  type FsOpReport,
  type FsPlace,
  type VerifiedDuplicateDeleteGroup,
} from "../../lib/bridge";
import {
  finishFileJob,
  registerFileJob,
  reportFromJob,
  waitForFileJob,
} from "../../lib/filesWorkspace/fileJobs";
import {
  invalidateDirs,
} from "../../lib/filesWorkspace/dirCache";
import {
  LAYOUT_PRESETS,
  MAX_TABS_PER_PANE,
  defaultTree,
  hasPane,
  paneIds,
  type SplitDirection,
  type SplitNode,
} from "../../lib/filesWorkspace/model";
import {
  cancelFwDrag,
  finishFwDrag,
  getFwDragState,
  isFwDragging,
  moveFwDrag,
  sameZone,
  subscribeFwDrag,
  getFwClipboard,
  setFwClipboard,
  clearFwClipboard,
  useFwClipboard,
  resolveEffect,
  type FwDropZone,
} from "../../lib/filesWorkspace/interactions";
import {
  bindSettingsStore,
  FILE_WORKSPACE_SETTING_KEY,
  normalizePersisted,
} from "../../lib/filesWorkspace/persist";
import { dropTargetAt, registerFileDropConsumer, discardOperation } from "../../lib/fileDrop";
import type { DragPayloadView } from "../../lib/dragPayload";
import {
  useFilesWorkspaceStore,
  tabTitle,
  type ApplyTemplateResult,
} from "../../store/useFilesWorkspaceStore";
import { useTransferStore } from "../../store/useTransferStore";
import { resolvePathInputs } from "../../lib/crossTab/fileKinds";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useWorkbenchPageActive } from "../../lib/windowHost";
import type { OperationPreview, WorkspaceProject } from "../../lib/bridge";
import { parentOf, basename, normalizePath } from "../../lib/filesWorkspace/pathUtils";
import { pickFolder, validateFolderPath, type PickFolderResult } from "../../lib/filesWorkspace/folderPicker";
import { openDirInFilesWorkspace } from "../../lib/filesWorkspace/reveal";
import {
  detectTransferConflicts,
  checkSourcesExist,
  remainingSourcesAfterTransfer,
  filterTransferablePaths,
  pickAutomaticTarget,
  transferRefreshDirs,
  type ConflictStrategy,
  type TransferConflict,
  type TransferEffect,
  type TransferTarget,
} from "../../lib/filesWorkspace/transfer";
import {
  finishQueueOperation,
  startQueueOperation,
  withFileOperationSlot,
} from "../../lib/filesWorkspace/operationQueue";

import OperationQueueBar from "./OperationQueueBar";
import BatchRenameDialog, { type BatchRenameRequest } from "./BatchRenameDialog";
import FolderCompareDialog, { type CompareRequest } from "./FolderCompareDialog";
import QuickPreviewDialog, { type PreviewRequest } from "./QuickPreviewDialog";
import WorkspaceSearchDialog from "./WorkspaceSearchDialog";
import DuplicateFinderDialog, { type DuplicateDeleteOutcome } from "./DuplicateFinderDialog";
import OperationPreviewDialog from "./OperationPreviewDialog";
import {
  previewFileOperation,
  shouldPreviewTransfer,
} from "../../lib/filesWorkspace/operationPreview";
const FilePane = lazy(() => import("./FilePane"));
const RecycleWorkspaceView = lazy(() => import("./RecycleWorkspaceView"));
import { pruneScrollSessions } from "./FileList";

/** 最小窗格尺寸（CSS px）：分割比例按容器实测换算钳制。 */
const MIN_PANE_W = 220;
const MIN_PANE_H = 140;

// store 的串行写入链绑定设置存储（模块加载即绑定，幂等）。
bindSettingsStore(() => useSettingsStore.getState());

// ── 递归分割渲染 ────────────────────────────────────────────────────────

interface SplitRenderProps {
  node: SplitNode;
  pageActive: boolean;
  maximizedPaneId: string | null;
  dropHintPane: string | null;
  dropHint: FwDropZone | null;
  onHoverZone: (zone: FwDropZone | null) => void;
  layoutEditMode: boolean;
  projectRoot: string | null;
}

function SplitRender({ node, pageActive, maximizedPaneId, dropHintPane, dropHint, onHoverZone, layoutEditMode, projectRoot }: SplitRenderProps) {
  const store = useFilesWorkspaceStore;
  if (node.type === "pane") {
    return (
      <Suspense fallback={<div className="fw-pane-loading" role="status" />}>
        <FilePane
          paneId={node.paneId}
          active={store.getState().activePaneId === node.paneId}
          pageActive={pageActive}
          onHoverZone={onHoverZone}
          dropHint={dropHintPane === node.paneId ? dropHint : null}
          layoutEditMode={layoutEditMode}
          projectRoot={projectRoot}
        />
      </Suspense>
    );
  }
  return (
    <SplitWithDivider
      node={node}
      pageActive={pageActive}
      maximizedPaneId={maximizedPaneId}
      dropHintPane={dropHintPane}
      dropHint={dropHint}
      onHoverZone={onHoverZone}
      layoutEditMode={layoutEditMode}
      projectRoot={projectRoot}
    />
  );
}

/** 触发点是否真实可见：offsetParent 为 null（display:none / 祖先隐藏）或矩形零尺寸都视为不可见。 */
function isElementVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.offsetParent === null) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * 抽屉锚点解析（纯函数，便于回归）：优先打开时的触发点；它被隐藏后跟随另一可见
 * 按钮；两个都不可见返回 null，由 positionOverride 退化为视口居中，而不是落到原点。
 */
export function resolveDrawerAnchor(
  origin: "toolbar" | "more",
  layoutVisible: boolean,
  moreVisible: boolean,
): "layout" | "more" | null {
  if (origin === "more") return moreVisible ? "more" : layoutVisible ? "layout" : null;
  return layoutVisible ? "layout" : moreVisible ? "more" : null;
}

/** 锚点全部不可见时的视口居中退化位置；有锚点或抽屉未打开时返回 null。 */
export function drawerCenterOverride(
  open: boolean,
  anchor: "layout" | "more" | null,
  viewport: { width: number; height: number },
  size: { width: number; height: number } = { width: 280, height: 320 },
): { left: number; top: number } | null {
  if (!open || anchor !== null) return null;
  return centerPopupInViewport(size, viewport);
}

/**
 * 抽屉锚点可见性监听：窗口尺寸变化与**父容器**尺寸变化都要触发重算。
 * 返回取消订阅函数（组件卸载/抽屉关闭时调用）。
 */
export function watchAnchorResize(el: HTMLElement | null, onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  let observer: ResizeObserver | null = null;
  if (el && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(onChange);
    observer.observe(el);
  }
  return () => {
    window.removeEventListener("resize", onChange);
    observer?.disconnect();
  };
}

export function SplitWithDivider({
  node,
  pageActive,
  maximizedPaneId,
  dropHintPane,
  dropHint,
  onHoverZone,
  layoutEditMode,
  projectRoot,
}: SplitRenderProps & { node: Extract<SplitNode, { type: "split" }> }) {
  const { t } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const store = useFilesWorkspaceStore;
  const horizontal = node.direction === "horizontal";
  const minPx = horizontal ? MIN_PANE_W : MIN_PANE_H;
  const [ratioHint, setRatioHint] = useState<string | null>(null);
  const [ratioMenu, setRatioMenu] = useState<{ x: number; y: number } | null>(null);
  /** 容器实测尺寸：aria-valuemin/max 与真实可拖范围必须由同一套边界换算。 */
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const dragRef = useRef<{
    pointerId: number;
    /** 实际建立指针捕获的分隔条：嵌套分割时不能用 querySelector 猜第一个。 */
    divider: HTMLElement;
    startPos: number;
    startRatio: number;
    size: number;
    minRatio: number;
    maxRatio: number;
    lastRatio: number;
    raf: number;
  } | null>(null);

  // 容器尺寸变化（窗口/分栏/最大化恢复）时重算边界；aria 与实际布局共用 bounds。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setContainerSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bounds = useMemo(() => {
    const measured = horizontal ? containerSize.width : containerSize.height;
    const size = measured || 1000;
    const min = Math.min(0.45, minPx / Math.max(size, minPx * 2));
    const max = 1 - min;
    return { value: Math.min(max, Math.max(min, node.ratio)), min, max };
  }, [containerSize.height, containerSize.width, horizontal, minPx, node.ratio]);

  // 容器缩到当前比例超出合法区间时，把 store 也收敛到同一有效值，避免
  // 「Store 比例 / ARIA / 实际布局」三者分叉（只在越界时写一次）。
  useEffect(() => {
    if (Math.abs(node.ratio - bounds.value) > 0.0005) {
      store.getState().updateRatio(node.id, bounds.value);
    }
  }, [bounds.value, node.id, node.ratio, store]);

  const setHint = (ratio: number) => {
    const pct = Math.round(ratio * 100);
    setRatioHint(`${pct}% / ${100 - pct}%`);
  };

  const endResizeVisual = useCallback((pointerId?: number, divider?: HTMLElement | null) => {
    document.body.classList.remove("fw-resizing", "fw-resizing-col", "fw-resizing-row");
    if (pointerId !== undefined) {
      try {
        divider?.releasePointerCapture(pointerId);
      } catch {
        // 指针已释放/捕获已丢失时 releasePointerCapture 会抛 DOMException；无需补偿。
      }
    }
    setRatioHint(null);
  }, []);

  const cancelResize = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.raf) cancelAnimationFrame(drag.raf);
    dragRef.current = null;
    store.getState().cancelRatioResize();
    endResizeVisual(drag.pointerId, drag.divider);
  }, [endResizeVisual, store]);

  useEffect(() => {
    if (!ratioMenu) return;
    const close = () => setRatioMenu(null);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [ratioMenu]);

  // 窗口失焦没有 pointercancel 时也必须退出调整态并回滚临时比例。
  useEffect(() => {
    const onBlur = () => cancelResize();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [cancelResize]);

  const beginResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const size = horizontal ? rect.width : rect.height;
    const minRatio = Math.min(0.45, minPx / Math.max(size, minPx * 2));
    const maxRatio = 1 - minRatio;
    const startPos = horizontal ? event.clientX : event.clientY;
    // 整个拖动只入一条撤销记录；移动帧走 previewRatio。
    store.getState().beginRatioResize(node.id);
    dragRef.current = {
      pointerId: event.pointerId,
      divider: event.currentTarget,
      startPos,
      startRatio: node.ratio,
      size,
      minRatio,
      maxRatio,
      lastRatio: node.ratio,
      raf: 0,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add("fw-resizing", horizontal ? "fw-resizing-col" : "fw-resizing-row");
    setHint(node.ratio);
  };

  const onResizeMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const pos = horizontal ? event.clientX : event.clientY;
    const ratio = Math.min(
      drag.maxRatio,
      Math.max(drag.minRatio, drag.startRatio + (pos - drag.startPos) / Math.max(drag.size, 1)),
    );
    drag.lastRatio = ratio;
    if (!drag.raf) {
      drag.raf = requestAnimationFrame(() => {
        const current = dragRef.current;
        if (!current) return;
        current.raf = 0;
        store.getState().previewRatio(node.id, current.lastRatio);
        setHint(current.lastRatio);
      });
    }
  };

  const finishResize = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.raf) {
      cancelAnimationFrame(drag.raf);
      drag.raf = 0;
    }
    const finalRatio = drag.lastRatio;
    dragRef.current = null;
    // 松开前把最后一帧比例同步提交，避免 rAF 被取消后丢失最后一次移动。
    if (Math.abs(finalRatio - drag.startRatio) < 0.0005) {
      store.getState().cancelRatioResize();
    } else {
      store.getState().previewRatio(node.id, finalRatio);
      store.getState().commitRatioResize();
    }
    endResizeVisual(drag.pointerId, drag.divider);
  };

  const nudge = (delta: number) => {
    const current = Math.min(bounds.max, Math.max(bounds.min, node.ratio + delta));
    store.getState().updateRatio(node.id, current);
  };

  const applyRatio = (ratio: number) => {
    store.getState().updateRatio(node.id, Math.min(bounds.max, Math.max(bounds.min, ratio)));
    setRatioMenu(null);
  };

  // 比例按整块容器计：先去一半 8px 命中区，保证 50% 时两侧等宽、分割线居中。
  const firstStyle = horizontal
    ? { width: `calc(${bounds.value * 100}% - 4px)` }
    : { height: `calc(${bounds.value * 100}% - 4px)` };

  return (
    <div ref={ref} className={`fw-split fw-split-${node.direction}`}>
      <div className="fw-split-child" style={firstStyle}>
        <SplitRender
          node={node.first}
          pageActive={pageActive}
          maximizedPaneId={maximizedPaneId}
          dropHintPane={dropHintPane}
          dropHint={dropHint}
          onHoverZone={onHoverZone}
          layoutEditMode={layoutEditMode}
          projectRoot={projectRoot}
        />
      </div>
      <div
        className={`fw-divider${horizontal ? " is-horizontal" : " is-vertical"}${ratioHint ? " is-dragging" : ""}`}
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-label={t("fw.divider.aria")}
        aria-valuemin={Number((bounds.min * 100).toFixed(1))}
        aria-valuemax={Number((bounds.max * 100).toFixed(1))}
        aria-valuenow={Number((bounds.value * 100).toFixed(1))}
        tabIndex={0}
        onPointerDown={beginResize}
        onPointerMove={onResizeMove}
        onPointerUp={finishResize}
        onPointerCancel={cancelResize}
        onLostPointerCapture={() => {
          if (dragRef.current) cancelResize();
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          applyRatio(0.5);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setRatioMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.1 : 0.03;
          if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            nudge(-step);
          } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            nudge(step);
          } else if (event.key === "Home") {
            // 与 WorkspaceSplit 对齐：跳到最小边界（first 侧最小宽度）。
            event.preventDefault();
            applyRatio(bounds.min);
          } else if (event.key === "End") {
            // 跳到最大边界（second 侧最小宽度）。
            event.preventDefault();
            applyRatio(bounds.max);
          } else if (event.key === "Enter") {
            // 双击/回车复位为 50%。
            event.preventDefault();
            applyRatio(0.5);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setRatioMenu(null);
            if (dragRef.current) cancelResize();
          }
        }}
      >
        <span className="fw-divider-line" aria-hidden="true" />
        {ratioHint && <span className="fw-divider-ratio">{ratioHint}</span>}
      </div>
      {ratioMenu && (
        <PointerMenu
          open={ratioMenu !== null}
          x={ratioMenu.x}
          y={ratioMenu.y}
          label={t("fw.divider.ratioMenu")}
          className="fw-divider-menu"
          trapFocus={false}
          onClose={() => setRatioMenu(null)}
        >
          {[0.25, 1 / 3, 0.5, 2 / 3, 0.75].map((ratio) => (
            <button
              key={ratio}
              type="button"
              role="menuitem"
              onClick={() => applyRatio(ratio)}
              className={Math.abs(node.ratio - ratio) < 0.005 ? "is-current" : ""}
            >
              {Math.round(ratio * 100)} : {Math.round((1 - ratio) * 100)}
            </button>
          ))}
        </PointerMenu>
      )}
      <div className="fw-split-child fw-split-child-second">
        <SplitRender
          node={node.second}
          pageActive={pageActive}
          maximizedPaneId={maximizedPaneId}
          dropHintPane={dropHintPane}
          dropHint={dropHint}
          onHoverZone={onHoverZone}
          layoutEditMode={layoutEditMode}
          projectRoot={projectRoot}
        />
      </div>
    </div>
  );
}

// ── 主面板 ──────────────────────────────────────────────────────────────

/** 「打开文件夹」的落点语义：当前新标签 / 替换当前目录 / 四方向新分栏。 */
export type OpenFolderMode = "newTab" | "replace" | "left" | "right" | "top" | "bottom";

interface PanelProps {
  project: WorkspaceProject | null;
}

/** 目录行（打开文件夹对话框 / 空窗格共用）：整行可点，固定按钮独立可点。 */
function DirRow({
  path,
  name,
  pinned,
  onOpen,
  onPin,
}: {
  path: string;
  name?: string;
  pinned: boolean;
  onOpen: () => void;
  onPin?: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="fw-dir-row">
      <button type="button" className="fw-dir-row-main" title={path} onClick={onOpen}>
        <FolderOpen size={13} aria-hidden="true" />
        <span className="fw-dir-row-name">{name || basename(path) || path}</span>
        <span className="fw-dir-row-path">{path}</span>
      </button>
      {onPin && (
        <button
          type="button"
          className="fw-icon-btn fw-dir-row-pin"
          aria-label={pinned ? t("fw.pane.unpinDir") : t("fw.pane.pinDir")}
          data-tip={pinned ? t("fw.pane.unpinDir") : t("fw.pane.pinDir")}
          onClick={onPin}
        >
          {pinned ? <PinOff size={12} aria-hidden="true" /> : <Pin size={12} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

export default function FilesWorkspacePanel({ project }: PanelProps) {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const pageActive = useWorkbenchPageActive() ?? true;

  const tree = useFilesWorkspaceStore((s) => s.tree);
  const panes = useFilesWorkspaceStore((s) => s.panes);
  const activePaneId = useFilesWorkspaceStore((s) => s.activePaneId);
  const maximizedPaneId = useFilesWorkspaceStore((s) => s.maximizedPaneId);
  const hydrated = useFilesWorkspaceStore((s) => s.hydrated);
  const layoutEditMode = useFilesWorkspaceStore((s) => s.layoutEditMode);
  const undoCount = useFilesWorkspaceStore((s) => s.layoutHistory.length);
  const redoCount = useFilesWorkspaceStore((s) => s.layoutFuture.length);
  const stashed = useFilesWorkspaceStore((s) => s.stashed);
  const recentDirs = useFilesWorkspaceStore((s) => s.recentDirs);
  const pinnedDirs = useFilesWorkspaceStore((s) => s.pinnedDirs);
  const selectionMap = useFilesWorkspaceStore((s) => s.selection);
  const store = useFilesWorkspaceStore;

  const [dropHint, setDropHint] = useState<FwDropZone | null>(null);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutBtnRef = useRef<HTMLButtonElement>(null);
  /** 窄内容区「模板/存为模板」按钮被收纳进更多菜单后，抽屉改锚到更多按钮，避免锚点隐藏后浮层落到视口原点。 */
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [drawerAnchor, setDrawerAnchor] = useState<"toolbar" | "more">("toolbar");
  /** 抽屉打开期间窗口/布局尺寸变化时重算锚点可见性（触发按钮被收纳后换锚点或退化为居中）。 */
  const [anchorTick, setAnchorTick] = useState(0);
  const [openFolder, setOpenFolder] = useState<{ paneId: string; mode: OpenFolderMode } | null>(null);
  const [openFolderPath, setFolderPath] = useState("");
  const [pickBusy, setPickBusy] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [places, setPlaces] = useState<FsPlace[]>([]);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [settingsRevision, setSettingsRevision] = useState(0);
  /** 应用用户模板前的确认（替换整个工作现场，需明确提示并可先保存）。 */
  const [templatePending, setTemplatePending] = useState<{ id: string; name: string } | null>(null);
  /** 关闭其他区域时容量不足：收纳 or 取消（不得静默丢弃）。 */
  const [closeOthersBlocked, setCloseOthersBlocked] = useState<number | null>(null);
  const hoverZoneRef = useRef<FwDropZone | null>(null);
  const nativeDragOut = useRef(false);
  const hydrateGenRef = useRef(0);
  /** 已从持久化恢复过（true 后不再被「设置晚到补恢复」覆盖）。 */
  const savedHydratedRef = useRef(false);
  /** 键盘删除模式：Shift+Delete = 永久删除（独立确认语义）。 */
  const [deletePermanent, setDeletePermanent] = useState(false);
  /** 快速传输目标选择器（F5/F6 无明确目标、右键“复制到/移动到”）。 */
  const [transferPicker, setTransferPicker] = useState<{
    effect: TransferEffect;
    paths: string[];
    sourcePaneId: string;
  } | null>(null);
  /** 批量冲突：整批只弹一次；策略统一应用到所有同名项。 */
  const [conflictPending, setConflictPending] = useState<{
    effect: TransferEffect;
    paths: string[];
    targetDir: string;
    conflicts: TransferConflict[];
    after?: (report: FsOpReport | null) => void;
  } | null>(null);
  /** 大量复制/移动前的只读预演；确认后才进入冲突决策或执行。 */
  const [previewPending, setPreviewPending] = useState<{
    preview: OperationPreview;
    paths: string[];
    targetDir: string;
    effect: TransferEffect;
    after?: (report: FsOpReport | null) => void;
  } | null>(null);
  /** F5/F6 多窗格时优先复用上次目标（会话内）。 */
  const lastTransferTargetRef = useRef<string | null>(null);
  /** 批量重命名：预览/冲突拦截/后端逐项执行。 */
  const [batchRenameRequest, setBatchRenameRequest] = useState<BatchRenameRequest | null>(null);
  /** 文件夹对比：来源目录 + 其他窗格目标；哈希只在对话框内显式触发。 */
  const [compareRequest, setCompareRequest] = useState<CompareRequest | null>(null);
  /** 快速预览：同一目录的文件列表随请求携带，左右方向键切换。 */
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | null>(null);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  /** 标题栏二级入口：files = 文件工作区；recycle = 文件回收站索引视图。
      两者共用同一外壳与虚拟列表语言，但操作权限完全隔离。 */
  const [source, setSource] = useState<"files" | "recycle">("files");
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const paneTargets = useMemo<TransferTarget[]>(() => {
    const ids = paneIds(tree);
    return ids
      .map((paneId) => {
        const pane = panes[paneId];
        const tab = pane?.tabs.find((item) => item.tabId === pane.activeTabId);
        return tab
          ? {
              paneId,
              label: tabTitle(tab),
              dir: tab.path,
              active: paneId === activePaneId,
            }
          : null;
      })
      .filter((item): item is TransferTarget => Boolean(item));
  }, [tree, panes, activePaneId]);

  const searchSources = useMemo(
    () => paneTargets.map((target) => ({ paneId: target.paneId, label: target.label, path: target.dir })),
    [paneTargets],
  );

  /**
   * 搜索对话框的额外范围：项目根目录与固定目录（收藏范围的现有等价物）。
   * 只给搜索用；重复文件查找仍只扫描已打开窗格，避免默认扩大磁盘扫描。
   */
  const workspaceSearchSources = useMemo(() => {
    const list = [...searchSources];
    const seen = new Set(list.map((source) => source.path.toLowerCase()));
    const add = (paneId: string, label: string, path: string) => {
      const key = path.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ paneId, label, path });
    };
    if (project?.rootPath) add(`project:${project.id}`, project.name, project.rootPath);
    for (const path of pinnedDirs) add(`favorite:${path}`, basename(path) || path, path);
    return list;
  }, [searchSources, project, pinnedDirs]);

  // ── 项目 hydration（代际令牌防串位）──────────────────────────────────
  useEffect(() => {
    const stateKey = project?.id ? `project:${project.id}` : "global";
    const gen = ++hydrateGenRef.current;
    const persisted = normalizePersisted(
      (useSettingsStore.getState().settings as unknown as Record<string, unknown> | null)?.[
        FILE_WORKSPACE_SETTING_KEY
      ],
    );
    const saved = persisted.states[stateKey];
    if (saved) {
      savedHydratedRef.current = true;
      store.getState().hydrate(saved, stateKey);
    } else {
      // 无项目态：单窗格空布局；有项目根目录时第一个窗格打开根目录。
      // （设置若尚未加载完成，下面的订阅会在设置到达后补一次恢复。）
      const freshTree = defaultTree();
      store.getState().hydrate({ tree: freshTree, panes: [], activePaneId: paneIds(freshTree)[0] }, stateKey);
      if (project?.rootPath) {
        store.getState().openInPane(paneIds(freshTree)[0], project.rootPath, "newTab");
      }
    }
    if (gen === hydrateGenRef.current) {
      store.getState().setStateKey(stateKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.rootPath]);

  // 模板列表读取：设置变化时刷新（修订号触发）。
  const persisted = useMemo(
    () => normalizePersisted(
      (useSettingsStore.getState().settings as unknown as Record<string, unknown> | null)?.[
        FILE_WORKSPACE_SETTING_KEY
      ],
    ),
    // settingsRevision 作为依赖：设置写入后重建模板列表。
    [settingsRevision],
  );

  /**
   * 工具栏快捷模板：最近使用优先（过滤已删除模板），不足 2 个按模板顺序补齐；
   * 只取前 2 个，其余走紧凑菜单。无模板时整个入口不渲染。
   */
  const quickTemplates = useMemo(() => {
    const byId = new Map(persisted.templates.map((tpl) => [tpl.id, tpl]));
    const picked: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    for (const id of persisted.recentTemplates) {
      if (picked.length >= 2) break;
      const tpl = byId.get(id);
      if (!tpl || seen.has(id)) continue;
      seen.add(id);
      picked.push({ id: tpl.id, name: tpl.name });
    }
    for (const tpl of persisted.templates) {
      if (picked.length >= 2) break;
      if (seen.has(tpl.id)) continue;
      seen.add(tpl.id);
      picked.push({ id: tpl.id, name: tpl.name });
    }
    return picked;
  }, [persisted]);

  /** 未进入快捷按钮的模板：宽栏从下拉箭头进入，窄栏从「模板」图标菜单进入。 */
  const remainingTemplates = useMemo(() => {
    const quick = new Set(quickTemplates.map((tpl) => tpl.id));
    return persisted.templates.filter((tpl) => !quick.has(tpl.id));
  }, [persisted.templates, quickTemplates]);
  useEffect(() => {
    const unsub = useSettingsStore.subscribe(() => {
      setSettingsRevision((n) => n + 1);
      // P0 竞态：settings 异步加载晚于面板挂载时，首次 hydrate 用的是空设置——
      // 已存布局若不在此补恢复，用户一操作就会被空布局覆盖。
      if (!savedHydratedRef.current) {
        const settings = useSettingsStore.getState().settings;
        if (settings) {
          const stateKey = store.getState().stateKey;
          const normalized = normalizePersisted(
            (settings as unknown as Record<string, unknown> | null)?.[FILE_WORKSPACE_SETTING_KEY],
          );
          const saved = normalized.states[stateKey];
          if (saved) {
            savedHydratedRef.current = true;
            store.getState().hydrate(saved, stateKey);
          }
        }
      }
    });
    return () => unsub();
  }, [store]);

  // 标签关闭/移出后立即释放对应滚动会话缓存（纯会话内内存，不落库）；
  // 收纳标签仍保留位置，标签彻底从所有窗格与收纳中消失才驱逐。
  useEffect(() => {
    const live = new Set<string>();
    for (const pane of Object.values(panes)) for (const tab of pane.tabs) live.add(tab.tabId);
    for (const tab of stashed) live.add(tab.tabId);
    pruneScrollSessions(live);
  }, [panes, stashed]);

  // 抽屉打开期间监听窗口与父容器尺寸变化：锚点按钮被容器查询收纳/恢复后，重算可见触发点。
  // 只监听 window.resize 会漏掉「窗口不变、面板/分栏变窄」导致的按钮隐藏。
  useEffect(() => {
    if (!layoutOpen) return;
    return watchAnchorResize(rootRef.current, () => setAnchorTick((n) => n + 1));
  }, [layoutOpen]);

  // 抽屉锚点退化：优先打开时的触发点；它被隐藏（display:none / 零尺寸）后跟随另一
  // 个可见按钮；两个都不可见时不锚到视口原点，改由 positionOverride 退化为视口居中。
  const layoutAnchorVisible = isElementVisible(layoutBtnRef.current);
  const moreAnchorVisible = isElementVisible(moreBtnRef.current);
  const drawerAnchorKind = resolveDrawerAnchor(drawerAnchor, layoutAnchorVisible, moreAnchorVisible);
  const drawerAnchorRef =
    drawerAnchorKind === "layout" ? layoutBtnRef : drawerAnchorKind === "more" ? moreBtnRef : null;
  const drawerPositionOverride = drawerCenterOverride(layoutOpen, drawerAnchorKind, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  void anchorTick;

  // ── 快速位置 ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!openFolder) return;
    void fsPlaces()
      .then(setPlaces)
      .catch(() => setPlaces([]));
  }, [openFolder]);

  // 「打开文件夹」事件（空窗格 / 标签栏 + / 窗格菜单）
  useEffect(() => {
    const onOpen = (e: Event) => {
      const paneId = (e as CustomEvent<string>).detail;
      setFolderPath("");
      setPickError(null);
      setOpenFolder({ paneId, mode: "newTab" });
    };
    window.addEventListener("taskdock-fw-open-folder", onOpen);
    return () => window.removeEventListener("taskdock-fw-open-folder", onOpen);
  }, []);

  // 资源管理面板 / 其他入口：跳到回收站数据源（不新建窗口、不新增页面）。
  useEffect(() => {
    const onOpenRecycle = () => setSource("recycle");
    window.addEventListener("taskdock-fw-open-recycle", onOpenRecycle);
    return () => window.removeEventListener("taskdock-fw-open-recycle", onOpenRecycle);
  }, []);

  // 窗格右键「复制到…/移动到…」：文件名/数量与目标目录由统一选择器确认。
  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<{
        effect?: TransferEffect;
        paths?: string[];
        sourcePaneId?: string;
      }>).detail;
      if (!detail?.paths?.length) return;
      const s = store.getState();
      setTransferPicker({
        effect: detail.effect === "move" ? "move" : "copy",
        paths: [...detail.paths],
        sourcePaneId: detail.sourcePaneId ?? s.activePaneId,
      });
    };
    window.addEventListener("taskdock-fw-request-transfer", onRequest);
    return () => window.removeEventListener("taskdock-fw-request-transfer", onRequest);
  }, [store]);

  // 批量重命名：FilePane 右键/选中上下文只派发请求，对话框由面板统一持有。
  useEffect(() => {
    const onBatch = (e: Event) => {
      const detail = (e as CustomEvent<BatchRenameRequest>).detail;
      if (!detail?.paths || detail.paths.length < 2) return;
      setBatchRenameRequest({ paneId: detail.paneId, paths: [...detail.paths] });
    };
    window.addEventListener("taskdock-fw-batch-rename", onBatch);
    return () => window.removeEventListener("taskdock-fw-batch-rename", onBatch);
  }, []);

  // 文件夹对比：来源取当前目录（单选目录时取该目录），目标只列其他已打开窗格。
  useEffect(() => {
    const onCompare = (e: Event) => {
      const detail = (e as CustomEvent<{ paneId: string; paths: string[] }>).detail;
      if (!detail?.paneId) return;
      void (async () => {
        const s = store.getState();
        const pane = s.panes[detail.paneId];
        const tab = pane?.tabs.find((item) => item.tabId === pane.activeTabId);
        if (!tab) return;
        let sourceDir = tab.path;
        let sourceLabel = tabTitle(tab);
        if (detail.paths?.length === 1) {
          try {
            const [stat] = await fsStat([detail.paths[0]]);
            if (stat?.exists && stat.kind === "dir") {
              sourceDir = stat.path;
              sourceLabel = basename(stat.path);
            }
          } catch {
            // 选择项已失效时回退到当前目录，不阻断对比入口。
          }
        }
        const targets = paneTargets.filter(
          (item) => item.paneId !== detail.paneId && item.dir.toLocaleLowerCase() !== sourceDir.toLocaleLowerCase(),
        );
        if (!targets.length) {
          showToast(t("fw.compare.noTarget"), { kind: "warning" });
          return;
        }
        setCompareRequest({ sourceDir, sourceLabel, targets });
      })();
    };
    window.addEventListener("taskdock-fw-compare", onCompare);
    return () => window.removeEventListener("taskdock-fw-compare", onCompare);
  }, [paneTargets, showToast, store, t]);

  // 快速预览：FilePane 携带当前目录的可见文件列表，方向键可安全切换。
  useEffect(() => {
    const onPreview = (e: Event) => {
      const detail = (e as CustomEvent<PreviewRequest>).detail;
      if (!detail?.path || !detail.entries?.length) return;
      setPreviewRequest(detail);
    };
    window.addEventListener("taskdock-fw-preview", onPreview);
    return () => window.removeEventListener("taskdock-fw-preview", onPreview);
  }, []);

  // ── 应用内拖拽/快速传输共用的真实文件操作 ────────────────────────────
  const applyFileDrop = useCallback(
    async (
      paths: string[],
      targetDir: string,
      effect: "copy" | "move",
      strategy: ConflictStrategy = "rename",
    ): Promise<FsOpReport | null> => {
      // 操作 ID 与 trace 由前端生成、Rust 沿用：诊断与任务服务共享同一个 ID；
      // traceId 贯穿前端 operation → IPC → Rust 异步 worker 诊断事件，只做关联、不参与鉴权。
      const { operation: op, traceId } = startTracedOperation(
        "file",
        effect === "copy" ? "workspace_copy" : "workspace_move",
        {
          component: "文件工作区",
          metadata: { count: paths.length },
        },
      );
      try {
        op.stage("job");
        const initial = await withFileOperationSlot(() =>
          effect === "copy"
            ? fsCopyJobStart(paths, targetDir, strategy, op.id, traceId)
            : fsMoveJobStart(paths, targetDir, strategy, op.id, traceId),
        );
        // 即时快照只反映入队/预检结果：终态失败或取消如实归因；运行中不伪造成功或实时进度，
        // 业务终态由 Rust 按同一 operation_id 写入权威诊断。
        if (initial.status === "failed") {
          op.fail(
            {
              code: initial.failures[0]?.code ?? "FS_OP_JOB_FAILED",
              message: initial.message ?? undefined,
            },
            { stage: "job", metadata: { total: initial.total, failed: initial.failed } },
          );
        } else if (initial.status === "cancelled" || initial.status === "cancelling") {
          op.cancel(initial.message ?? undefined);
        }
        // 立即登记快照：终态任务（空选择/全部预检失败）不必等 2.5s 轮询。
        registerFileJob(initial);
        const { job: final, report } = await finishFileJob(initial.id);
        invalidateDirs(transferRefreshDirs(paths, targetDir));
        // 移动成功才清来源选择；取消/部分完成/报告缺失时源仍可能仍在，保留选择。
        if (effect === "move" && report) {
          const remaining = new Set(remainingSourcesAfterTransfer(report, paths));
          store
            .getState()
            .removePathsFromSelections(paths.filter((path) => !remaining.has(path)));
          // R10：目录移动后同步所有标签的 openedPath/path/history（含子路径）。
          // 一次批量更新 + 一次持久化；文件项无匹配时内部直接返回 0，无副作用。
          const movedDirs = report.entries
            .filter((e) => e.status === "ok" && e.target && e.target !== e.source)
            .map((e) => ({ from: e.source, to: e.target as string }));
          if (movedDirs.length > 0) store.getState().remapTabPathsBatch(movedDirs);
        }
        if (!final) {
          showFileJobOutcome({ effect, job: null, t, showToast });
          return null;
        }
        if (final.status === "cancelled" || final.status === "cancelling") {
          showFileJobOutcome({ effect, job: final, t, showToast });
          return report;
        }
        if (report) {
          // 业务终态由 Rust 写入诊断（同一 operation_id）；这里只把「失败了几项、
          // 主要原因是什么、下一步去哪里看」讲清楚，不重复上报同一故障。
          showFsOpOutcome({ effect, report, t, showToast });
          return report;
        }
        // 任务计数已确认，但逐项报告不可读：不得声称全部成功，也不清理任何源。
        showToast(t("fw.queue.reportUnavailable", {
          ok: final.ok,
          failed: final.failed,
          skipped: final.skipped,
          remaining: Math.max(0, final.total - final.done),
        }), { kind: "warning" });
        return null;
      } catch (e) {
        // IPC 抛错已由 invokeCommand 归属（含命令名/错误码）并 markLogged；
        // 只有未被归属的错误才补一条终态，不重复上报同一故障。
        if (!isLogged(e as object)) op.fail(e, { stage: "ipc" });
        showToast(errorMessage(e), { kind: "error" });
        return null;
      }
    },
    [showToast, store, t],
  );

  /**
   * 统一入口：先检测同名冲突；有冲突只弹一次决策，再执行。
   * 冲突检测失败时中止（宁可不操作，也不静默按 rename 覆盖用户预期）。
   */
  const requestTransfer = useCallback(
    async (
      paths: string[],
      targetDir: string,
      effect: TransferEffect,
      after?: (report: FsOpReport | null) => void,
    ): Promise<FsOpReport | null> => {
      if (!paths.length) return null;
      const effective = filterTransferablePaths(paths, targetDir);
      if (!effective.length) {
        showToast(t("fw.quick.alreadyHere"), { kind: "info" });
        return null;
      }
      try {
        // 大量复制/移动先只读预演；小批量保持直接执行，避免日常操作变慢。
        if (shouldPreviewTransfer(effective.length, effect)) {
          const preview = await previewFileOperation({ paths: effective, targetDir, effect });
          setPreviewPending({ preview, paths: effective, targetDir, effect, after });
          return null;
        }
        const conflicts = await detectTransferConflicts(effective, targetDir);
        if (conflicts.length > 0) {
          setConflictPending({ effect, paths: effective, targetDir, conflicts, after });
          return null;
        }
        const report = await applyFileDrop(effective, targetDir, effect);
        after?.(report);
        return report;
      } catch (e) {
        showToast(errorMessage(e), { kind: "error" });
        return null;
      }
    },
    [applyFileDrop, showToast, t],
  );

  /**
   * 预演确认（FW-OPS-003）：预演不是执行授权——确认瞬间重新验证磁盘状态，
   * 后端执行阶段还会再做一次路径与权限校验。
   * 1) 目标目录仍存在且是目录；2) 源条目仍存在（不完整预演只处理可访问项）；
   * 3) 重新检测同名冲突（预演时刻的冲突可能已消失/新增）；取消不产生写入。
   */
  const confirmPreview = useCallback(() => {
    const pending = previewPending;
    if (!pending) return;
    setPreviewPending(null);
    void (async () => {
      try {
        const [targetStat] = await fsStat([pending.targetDir]);
        if (!targetStat?.exists || targetStat.kind !== "dir") {
          showToast(t("fw.transfer.targetMissing", { path: pending.targetDir }), { kind: "error" });
          return;
        }
        let paths = pending.paths;
        if (!pending.preview.complete) {
          // 用户已勾选「只处理可访问项」：剔除预演时无法统计的源，绝不带上未知状态执行。
          const inaccessible = new Set(
            pending.preview.inaccessible.map((p) => normalizePath(p).toLowerCase()),
          );
          paths = paths.filter((p) => !inaccessible.has(normalizePath(p).toLowerCase()));
        }
        const { existing, vanished } = await checkSourcesExist(paths);
        if (!existing.length) {
          showToast(t("fw.transfer.sourcesVanishedAll"), { kind: "warning" });
          return;
        }
        if (vanished.length > 0) {
          showToast(t("fw.transfer.sourcesVanished", { count: vanished.length }), { kind: "warning" });
        }
        const conflicts = await detectTransferConflicts(existing, pending.targetDir);
        if (conflicts.length > 0) {
          setConflictPending({
            effect: pending.effect,
            paths: existing,
            targetDir: pending.targetDir,
            conflicts,
            after: pending.after,
          });
          return;
        }
        const report = await applyFileDrop(existing, pending.targetDir, pending.effect);
        pending.after?.(report);
      } catch (e) {
        showToast(errorMessage(e), { kind: "error" });
      }
    })();
  }, [applyFileDrop, previewPending, showToast, t]);

  // 窗格空白处「粘贴」只派发目标目录；执行、进度与剪切板收尾统一留在面板，
  // 不再让 FilePane 维护第二套复制/移动 IPC 流程。
  useEffect(() => {
    const onTransferTo = (e: Event) => {
      const detail = (e as CustomEvent<{ targetDir?: string }>).detail;
      if (!detail?.targetDir) return;
      const clip = getFwClipboard();
      if (!clip?.paths.length) return;
      const lastMode = clip.mode;
      const after =
        lastMode === "cut"
          ? (report: FsOpReport | null) => {
              const pending = remainingSourcesAfterTransfer(report, clip.paths);
              setFwClipboard(
                pending.length
                  ? { mode: "cut", paths: pending, sourcePaneId: clip.sourcePaneId }
                  : null,
              );
            }
          : undefined;
      void requestTransfer(clip.paths, detail.targetDir, lastMode === "copy" ? "copy" : "move", after);
    };
    window.addEventListener("taskdock-fw-transfer-to", onTransferTo);
    return () => window.removeEventListener("taskdock-fw-transfer-to", onTransferTo);
  }, [requestTransfer]);

  const revealSearchHit = useCallback(
    (paneId: string, dirPath: string, filePath: string) => {
      const s = store.getState();
      // 项目/收藏来源不是真实窗格：定位时落到当前活动窗格，绝不新建窗格或伪造 ID。
      const targetPaneId = hasPane(s.tree, paneId) ? paneId : s.activePaneId;
      s.setActivePane(targetPaneId);
      const opened = s.openInPane(targetPaneId, dirPath, "replace");
      if (opened) s.setSelection(targetPaneId, [filePath]);
      else showToast(t("fw.search.revealFailed"), { kind: "error" });
    },
    [showToast, store, t],
  );

  /** 重复文件对话框的删除出口：只在服务端重新哈希通过后走回收站。 */
  const deleteDuplicatePaths = useCallback(
    async (groups: VerifiedDuplicateDeleteGroup[]): Promise<DuplicateDeleteOutcome> => {
      const paths = groups.flatMap((group) => group.deletePaths);
      if (!paths.length) return { ok: 0, failed: 0, failedPaths: [] };
      const dirs = [...new Set(paths.map((path) => parentOf(path)).filter(Boolean))] as string[];
      const op = startOperation("file", "workspace_delete_duplicates", {
        component: "文件工作区",
        metadata: { groups: groups.length, count: paths.length },
      });
      startQueueOperation({ id: op.id, effect: "delete", total: paths.length });
      try {
        op.stage("ipc");
        // 后端现在是标准 fsops 任务：先拿快照，再等终态（事件为主、轮询兜底），
        // 取消走 `fs_job_cancel`，与复制/移动/删除完全一致。
        const snapshot = await withFileOperationSlot(() =>
          fsDeleteVerifiedDuplicates(groups, op.id),
        );
        registerFileJob(snapshot);
        const { job, report } = await finishFileJob(snapshot.id);
        invalidateDirs(dirs);
        if (!job) {
          // 任务已不可追踪：绝不能当成成功，也不能清掉源选择。
          finishQueueOperation(op.id, null, "任务状态不可追踪");
          showToast(t("fw.duplicates.deleteUnknown"), { kind: "error" });
          return { ok: 0, failed: paths.length, failedPaths: paths };
        }
        const finalReport = report ?? reportFromJob(job);
        finishQueueOperation(op.id, finalReport);
        const failedPaths = finalReport.entries
          .filter((entry) => entry.status !== "ok")
          .map((entry) => entry.source);
        if (failedPaths.length > 0) {
          showToast(
            t("fw.duplicates.deletePartial", { ok: finalReport.ok, failed: failedPaths.length }),
            { kind: "error" },
          );
        } else {
          showToast(t("fw.duplicates.deleted", { count: finalReport.ok }), { kind: "success" });
        }
        return { ok: finalReport.ok, failed: failedPaths.length, failedPaths };
      } catch (e) {
        if (!isLogged(e as object)) op.fail(e, { stage: "ipc" });
        finishQueueOperation(op.id, null, errorMessage(e));
        showToast(errorMessage(e), { kind: "error" });
        return { ok: 0, failed: paths.length, failedPaths: paths };
      }
    },
    [showToast, t],
  );

  /** F5/F6 与快速按钮共用：两窗格直接另一个；多窗格优先上次目标；否则弹选择器。 */
  const quickTransfer = useCallback(
    (effect: TransferEffect) => {
      const s = store.getState();
      const paneId = s.activePaneId;
      const selection = s.selection[paneId]?.paths ?? [];
      if (!selection.length) {
        showToast(t("fw.quick.noSelection"), { kind: "info" });
        return;
      }
      const targets = paneTargets.filter((target) => target.paneId !== paneId);
      if (!targets.length) {
        showToast(t("fw.quick.noTarget"), { kind: "info" });
        return;
      }
      const decided = pickAutomaticTarget({
        sourcePaneId: paneId,
        paneIds: targets.map((target) => target.paneId),
        lastTargetPaneId: lastTransferTargetRef.current,
      });
      if (decided.needsPicker || !decided.paneId) {
        setTransferPicker({ effect, paths: [...selection], sourcePaneId: paneId });
        return;
      }
      const target = targets.find((item) => item.paneId === decided.paneId);
      if (!target) {
        setTransferPicker({ effect, paths: [...selection], sourcePaneId: paneId });
        return;
      }
      lastTransferTargetRef.current = target.paneId;
      void requestTransfer(selection, target.dir, effect);
    },
    [paneTargets, requestTransfer, showToast, store, t],
  );



  useEffect(() => {
    const clearHints = () => {
      hoverZoneRef.current = null;
      setDropHint(null);
    };
    const onMove = (e: PointerEvent) => {
      // WebView2 在松开左键前保留鼠标捕获，pointerleave 可能来得太晚。
      if (e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
        startNativeDragOut(e);
        return;
      }
      // 协调器唯一坐标入口（P0：旧实现坐标只在拖拽起点写入，hover 永远冻结）。
      moveFwDrag(e.clientX, e.clientY, e);
    };
    const onUp = () => {
      if (!isFwDragging()) return;
      const st = getFwDragState();
      const zone = st.hover;
      const payload = st.payload;
      finishFwDrag();
      clearHints();
      if (!zone || !payload) return;
      const s = store.getState();
      if (payload.kind === "pane") {
        // 布局编辑模式：区域交换就是两个叶节点换位置——不新建窗格、不搬标签、
        // 不触发任何文件系统操作（标签仍属于原窗格 ID，导航状态原样保留）。
        if (zone.type === "pane-swap" && zone.paneId !== payload.fromPaneId) {
          if (s.swapPanes(payload.fromPaneId, zone.paneId)) {
            showToast(t("fw.drag.swapped"), { kind: "success" });
          }
        }
        return;
      }
      if (payload.kind === "tabs") {
        if (zone.type === "edge") {
          // 四方向分栏：左/上 = 前侧插入（树顺序必须与视觉一致，P0）。
          const direction: SplitDirection = zone.edge === "left" || zone.edge === "right" ? "horizontal" : "vertical";
          const side = zone.edge === "left" || zone.edge === "top" ? "before" : "after";
          if (!s.extractTabToPane(payload.tabIds[0], payload.fromPaneId, zone.paneId, direction, side)) {
            showToast(t("fw.drag.failed"), { kind: "warning" });
          }
        } else if (zone.type === "center") {
          if (zone.paneId === payload.fromPaneId) return;
          s.moveTabToPane(payload.tabIds[0], payload.fromPaneId, zone.paneId);
        } else if (zone.type === "tabbar") {
          if (zone.paneId === payload.fromPaneId) {
            const tabs = s.panes[payload.fromPaneId]?.tabs ?? [];
            const curIdx = tabs.findIndex((x) => x.tabId === payload.tabIds[0]);
            let to = zone.index;
            if (curIdx >= 0 && to > curIdx) to -= 1;
            if (curIdx >= 0 && to !== curIdx) s.reorderTab(payload.fromPaneId, curIdx, to);
          } else {
            s.moveTabToPane(payload.tabIds[0], payload.fromPaneId, zone.paneId, zone.index);
          }
        }
        return;
      }
      // files：center 自带 dir（组件层已按最新坐标解析）。
      const targetDir =
        zone.type === "folder"
          ? zone.path
          : zone.type === "center"
            ? zone.dir
            : null;
      if (!targetDir) return;
      const effect = resolveEffect(payload, targetDir, st.modifiers);
      void requestTransfer(payload.paths, targetDir, effect === "copy" ? "copy" : "move");
    };
    // 取消通道：Escape / pointercancel / 窗口失焦 / 卸载。
    // 取消绝不执行文件操作（P0：防误移动）。
    const onCancel = () => {
      if (!isFwDragging()) return;
      cancelFwDrag();
      clearHints();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFwDragging()) {
        e.preventDefault();
        onCancel();
        return;
      }
      // 按住不动按 Ctrl/Shift 也要即时刷新效果（Explorer 语义）。
      if (isFwDragging() && (e.key === "Control" || e.key === "Shift")) {
        moveFwDrag(undefined, undefined, e);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isFwDragging() && (e.key === "Control" || e.key === "Shift")) {
        moveFwDrag(undefined, undefined, e);
      }
    };
    const startNativeDragOut = (e: PointerEvent) => {
      if (!isFwDragging()) return;
      const { payload } = getFwDragState();
      onCancel();
      if (payload?.kind !== "files" || e.pointerType !== "mouse" || !(e.buttons & 1) || nativeDragOut.current) return;
      nativeDragOut.current = true;
      void fsDragOut(payload.paths)
        .catch((error) => showToast(errorMessage(error), { kind: "error" }))
        .finally(() => { nativeDragOut.current = false; });
    };
    const onLeaveDoc = (e: PointerEvent) => {
      if (!e.relatedTarget) startNativeDragOut(e);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerleave", onLeaveDoc);
    return () => {
      if (isFwDragging()) cancelFwDrag();
      clearHints();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("pointerleave", onLeaveDoc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestTransfer, store]);

  // hover zone 上报（来自各 Pane）：仅变化时 setState（拖拽中每帧 emit 不再牵动整树）。
  const onHoverZone = useCallback((zone: FwDropZone | null) => {
    if (sameZone(zone, hoverZoneRef.current)) return;
    hoverZoneRef.current = zone;
    setDropHint(zone);
  }, []);

  // ── 外部 OS 拖入（fileDrop 仲裁认领）────────────────────────────────
  useEffect(() => {
    /** 命中窗格：返回窗格 ID 与其当前目录（空窗格 dir 为 null）。 */
    const hitPane = (point: { x: number; y: number } | null): { paneId: string; dir: string | null } | null => {
      if (!point) return null;
      const paneId = dropTargetAt(point, "data-fw-pane-id");
      if (!paneId) return null;
      const s = store.getState();
      const pane = s.panes[paneId];
      const dir = pane?.tabs.find((x) => x.tabId === pane.activeTabId)?.path ?? null;
      return { paneId, dir };
    };
    const hitPaneDir = (point: { x: number; y: number } | null): string | null => hitPane(point)?.dir ?? null;
    /**
     * 空窗格 + 单个目录 = 「拖入文件夹打开它」；空窗格 + 文件 = 无效（没有目标目录）。
     * 两种语义按 §4.4 区分，绝不把目录当文件复制。
     */
    const openFolderIntoEmptyPane = async (hit: { paneId: string; dir: string | null }, path: string): Promise<boolean> => {
      if (hit.dir) return false;
      try {
        const [stat] = await fsStat([path]);
        if (!stat || stat.kind !== "dir") return false;
        const s = store.getState();
        if ((s.panes[hit.paneId]?.tabs.length ?? 0) > 0) return false;
        s.openInPane(hit.paneId, stat.path, "newTab");
        s.recordRecentDir(stat.path);
        return true;
      } catch {
        return false;
      }
    };
    const consumer = {
      id: "files-workspace",
      priority: 20,
      claim: () => pageActive && !nativeDragOut.current,
      onEnter: (point: { x: number; y: number } | null) => {
        const dir = point ? hitPaneDir(point) : null;
        onHoverZone(dir && point ? { type: "center", paneId: dropTargetAt(point, "data-fw-pane-id") ?? "", dir } : null);
      },
      onOver: (point: { x: number; y: number } | null) => {
        const dir = point ? hitPaneDir(point) : null;
        onHoverZone(dir && point ? { type: "center", paneId: dropTargetAt(point, "data-fw-pane-id") ?? "", dir } : null);
      },
      onLeave: () => onHoverZone(null),
      onDrop: (paths: string[], point: { x: number; y: number } | null) => {
        onHoverZone(null);
        const hit = hitPane(point);
        if (!hit || paths.length === 0) {
          if (paths.length > 0) showToast(t("fw.error.dropOutside"), { kind: "warning" });
          return;
        }
        if (!hit.dir) {
          if (paths.length === 1) {
            void openFolderIntoEmptyPane(hit, paths[0]).then((ok) => {
              if (!ok) showToast(t("fw.error.dropOutside"), { kind: "warning" });
            });
          } else {
            showToast(t("fw.error.dropOutside"), { kind: "warning" });
          }
          return;
        }
        void requestTransfer(paths, hit.dir, "copy");
      },
      onPayload: (payload: DragPayloadView, point: { x: number; y: number } | null, meta: { operationId: string }) => {
        onHoverZone(null);
        if (payload.kind === "local-files" && payload.paths.length) {
          const hit = hitPane(point);
          if (!hit) {
            void discardOperation(meta.operationId, "files-workspace-no-pane");
            showToast(t("fw.error.dropOutside"), { kind: "warning" });
            return;
          }
          if (!hit.dir) {
            if (payload.paths.length === 1) {
              void openFolderIntoEmptyPane(hit, payload.paths[0]).then((ok) => {
                if (!ok) showToast(t("fw.error.dropOutside"), { kind: "warning" });
                void discardOperation(meta.operationId, "files-workspace-opened-folder");
              });
            } else {
              void discardOperation(meta.operationId, "files-workspace-empty-pane-files");
              showToast(t("fw.error.dropOutside"), { kind: "warning" });
            }
            return;
          }
          // 外部来源恒为复制语义：绝不删用户源文件；消费后释放后端会话。
          void requestTransfer(payload.paths, hit.dir, "copy").then(() =>
            discardOperation(meta.operationId, "files-workspace-committed"),
          );
          return;
        }
        void discardOperation(meta.operationId, "files-workspace-unsupported-kind");
        showToast(t("fw.error.unsupportedDrop", { kind: payload.kind }), { kind: "warning" });
      },
    };
    const unregister = registerFileDropConsumer(consumer);
    return () => {
      unregister();
    };
  }, [requestTransfer, pageActive, showToast, store, t]);

  // ── 键盘快捷键（活动窗格）───────────────────────────────────────────
  useEffect(() => {
    if (!pageActive) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditor =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (inEditor) return;
      if (!hydrated) return;
      // 回收站视图有自己的选择/快捷键语义；普通文件快捷键不得作用于索引条目。
      if (sourceRef.current === "recycle") return;
      if (previewRequest) return; // 预览打开时方向键/Escape 归预览对话框，不触发文件操作
      const mod = e.ctrlKey || e.metaKey;
      // Windows 文件管理器习惯：Alt+Left/Right/Up 在活动窗格内前进/后退/上一级。
      // 必须在布局撤销之前处理，避免 Alt 组合被 Ctrl/Cmd 分支吞掉。
      if (e.altKey && !mod && !e.shiftKey) {
        const active = store.getState().activePaneId;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          store.getState().navigate(active, "back");
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          store.getState().navigate(active, "forward");
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          store.getState().navigate(active, "up");
          return;
        }
      }
      // 布局撤销/重做（只回滚布局与标签分配，绝不回滚真实文件操作）。
      if (mod && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        if (!store.getState().undoLayout()) showToast(t("fw.layout.nothingToUndo"), { kind: "info" });
        return;
      }
      if (mod && ((e.key === "y" || e.key === "Y") || ((e.key === "z" || e.key === "Z") && e.shiftKey))) {
        e.preventDefault();
        if (!store.getState().redoLayout()) showToast(t("fw.layout.nothingToRedo"), { kind: "info" });
        return;
      }
      if (e.key === "Escape" && store.getState().layoutEditMode) {
        e.preventDefault();
        store.getState().setLayoutEditMode(false);
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        quickTransfer("copy");
        return;
      }
      if (e.key === "F6") {
        e.preventDefault();
        quickTransfer("move");
        return;
      }
      if (e.key === "F7") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("taskdock-fw-new-folder", { detail: store.getState().activePaneId }));
        return;
      }
      if (e.key === "F2") {
        const s0 = store.getState();
        const current = s0.selection[s0.activePaneId]?.paths ?? [];
        if (current.length === 1) {
          e.preventDefault();
          window.dispatchEvent(
            new CustomEvent("taskdock-fw-rename", { detail: { paneId: s0.activePaneId, path: current[0] } }),
          );
          return;
        }
      }
      if (e.ctrlKey && (e.key === "Tab" || e.key === "l" || e.key === "L")) {
        e.preventDefault();
        const s0 = store.getState();
        const pane = s0.panes[s0.activePaneId];
        if (e.key === "Tab" && pane && pane.tabs.length > 0) {
          const idx = pane.tabs.findIndex((tab) => tab.tabId === pane.activeTabId);
          const step = e.shiftKey ? -1 : 1;
          const next = pane.tabs[(idx + step + pane.tabs.length) % pane.tabs.length];
          if (next) s0.setActiveTab(s0.activePaneId, next.tabId);
        } else if (e.key === "l" || e.key === "L") {
          window.dispatchEvent(new CustomEvent("taskdock-fw-focus-path", { detail: s0.activePaneId }));
        }
        return;
      }
      if (e.code === "Space") {
        const s0 = store.getState();
        const current = s0.selection[s0.activePaneId]?.paths ?? [];
        if (current.length === 1) {
          e.preventDefault();
          // 由持有可见条目的 FilePane 补齐 entries 后再打开预览；面板本身不持有目录列表。
          window.dispatchEvent(
            new CustomEvent("taskdock-fw-preview-request", {
              detail: { paneId: s0.activePaneId, path: current[0] },
            }),
          );
          return;
        }
      }
      const s = store.getState();
      const paneId = s.activePaneId;
      const pane = s.panes[paneId];
      const tab = pane?.tabs.find((x) => x.tabId === pane?.activeTabId);
      if (!tab) return;
      const selection = s.selection[paneId]?.paths ?? [];
      if (mod && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        // 全选：需要目录列表——由事件桥接给 Pane 太绕；直接用 dirCache 数据。
        void (async () => {
          const { getDirState } = await import("../../lib/filesWorkspace/dirCache");
          const listing = getDirState(tab.path, tab.showHidden).listing ?? [];
          s.setSelection(paneId, listing.map((entry) => `${tab.path}\\${entry.name}`), null);
        })();
      } else if (mod && (e.key === "c" || e.key === "C") && selection.length) {
        e.preventDefault();
        setFwClipboard({ mode: "copy", paths: [...selection], sourcePaneId: paneId });
        showToast(t("fw.report.clipCopy", { count: selection.length }), { kind: "info" });
      } else if (mod && (e.key === "x" || e.key === "X") && selection.length) {
        e.preventDefault();
        setFwClipboard({ mode: "cut", paths: [...selection], sourcePaneId: paneId });
        showToast(t("fw.report.clipCut", { count: selection.length }), { kind: "info" });
      } else if (mod && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        void (async () => {
          const clip = getFwClipboard();
          if (!clip) return;
          // 剪切语义（P0：失败不得静默清空剪切状态）：部分失败只保留未完成项。
          // 冲突决策可能延后执行，因此把剪贴板收尾作为 after 回调绑定到这次请求。
          const after =
            clip.mode === "cut"
              ? (report: FsOpReport | null) => {
                  // 只移除报告明确成功的项；失败/部分/取消未处理项仍留在剪切待办。
                  const pending = remainingSourcesAfterTransfer(report, clip.paths);
                  setFwClipboard(
                    pending.length
                      ? { mode: "cut", paths: pending, sourcePaneId: clip.sourcePaneId }
                      : null,
                  );
                }
              : undefined;
          await requestTransfer(clip.paths, tab.path, clip.mode === "copy" ? "copy" : "move", after);
        })();
      } else if (e.shiftKey && e.key === "Delete" && selection.length) {
        // 永久删除：独立入口 + 独立确认（不得混入回收站语义）。
        e.preventDefault();
        deletePathsRef.current = [...selection];
        setDeletePermanent(true);
        setDeleteOpen(true);
      } else if (e.key === "Delete" && selection.length) {
        e.preventDefault();
        void fsDeleteWithConfirm();
      } else if (e.key === "F2" && selection.length === 1) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("taskdock-fw-rename", { detail: { paneId, path: selection[0] } }));
      } else if (e.key === "Backspace" && !inEditor) {
        e.preventDefault();
        s.navigate(paneId, "up");
      } else if (e.key === "Escape" && selection.length) {
        s.clearSelection(paneId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageActive, hydrated, activePaneId, requestTransfer, quickTransfer, previewRequest]);

  // Delete 的确认语义（键盘触发时复用 ConfirmDialog）。
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deletePathsRef = useRef<string[]>([]);
  async function fsDeleteWithConfirm() {
    const s = store.getState();
    const selection = s.selection[s.activePaneId]?.paths ?? [];
    if (!selection.length) return;
    deletePathsRef.current = [...selection];
    setDeleteOpen(true);
  }

  // F2 重命名由 FilePane 直接监听 taskdock-fw-rename 打开对话框（不用
  // window.prompt：WebView2 禁用脚本对话框时静默返回 null，且不符组件层规范）。

  // 项目切换/卸载前落盘待写状态（P0 竞态：旧定时器晚 fire 会把新状态写进新键）。
  useEffect(() => {
    const onPageHide = () => {
      void store.getState().flushPending().catch(() => {});
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      void store.getState().flushPending().catch(() => {});
    };
  }, [store]);

  // 持久化写入失败可见反馈（P0：不得静默吞掉）。
  useEffect(() => {
    const unsub = useFilesWorkspaceStore.subscribe((s, prev) => {
      if (s.persistError && s.persistError !== prev.persistError) {
        showToast(t("fw.persist.failed", { error: s.persistError }), { kind: "error" });
      }
    });
    return unsub;
  }, [showToast, t]);

  // 暂存架 → 文件工作区投递接收端（发送侧在暂存架 UI，其他会话所有，不并行重造）：
  // window.dispatchEvent(new CustomEvent("taskdock-fw-deliver", { detail: { paths, mode } }))
  // mode 缺省恒为 copy（外部来源绝不删用户源文件）；move 仅在发送端明确声明时执行。
  useEffect(() => {
    const onDeliver = (e: Event) => {
      const detail = (e as CustomEvent<{ paths?: string[]; mode?: "copy" | "move" }>).detail;
      const paths = Array.isArray(detail?.paths) ? detail.paths : [];
      if (!paths.length) return;
      const s = store.getState();
      const pane = s.panes[s.activePaneId];
      const dir = pane?.tabs.find((x) => x.tabId === pane.activeTabId)?.path;
      if (!dir) {
        showToast(t("fw.error.dropOutside"), { kind: "warning" });
        return;
      }
      void requestTransfer(paths, dir, detail.mode === "move" ? "move" : "copy");
    };
    window.addEventListener("taskdock-fw-deliver", onDeliver);
    return () => window.removeEventListener("taskdock-fw-deliver", onDeliver);
  }, [requestTransfer, showToast, store, t]);

  // ── 布局动作 ────────────────────────────────────────────────────────
  /**
   * 应用布局预设：**保留全部已打开目录**（先收集标签 → 生成目标布局 → 稳定重分配），
   * 容量不足时阻止并给出明确反馈，绝不截断标签。
   */
  const applyLayoutPreset = (presetId: string) => {
    const result = store.getState().applyLayoutPresetPreservingTabs(presetId);
    if (!result.ok) {
      if (result.reason === "capacity") {
        showToast(t("fw.layout.capacityBlocked", { count: result.overflow }), { kind: "warning" });
      } else {
        showToast(t("fw.layout.unknownPreset"), { kind: "error" });
      }
      return;
    }
    if (!result.unchanged && result.stashedCount > 0) {
      showToast(t("fw.layout.stashed", { count: result.stashedCount }), { kind: "info" });
    }
    setLayoutOpen(false);
  };

  /**
   * 应用模板（快捷入口与模板抽屉共用同一实现）：按 store 返回结果反馈。
   * persist-failed 明确「已应用但未保存」，绝不显示成功；missing 刷新模板列表。
   */
  const applyCustomTemplate = async (templateId: string) => {
    const templates = persisted.templates.map((tpl) => ({ id: tpl.id, tree: tpl.tree, panes: tpl.panes }));
    // R13: store 已返回结构化结果并在内部完成持久化；失败必须在结果里显式说明。
    const result: ApplyTemplateResult = await store.getState().applyTemplate(templateId, templates);
    setTemplatePending(null);
    setLayoutOpen(false);
    if (!result.ok) {
      if (result.reason === "missing") {
        showToast("模板不存在或已被删除，已刷新模板列表", { kind: "warning" });
        setSettingsRevision((n) => n + 1);
        return;
      }
      showToast(`已应用模板，但${t("fw.persist.failed", { error: result.error ?? "" })}`, { kind: "error" });
      return;
    }
    // 应用会改变最近使用顺序（recentTemplates），重建列表让快捷入口跟随新顺序。
    setSettingsRevision((n) => n + 1);
    showToast(t("fw.template.applied"), { kind: "success" });
  };

  const saveCurrentTemplate = async (name: string) => {
    await store.getState().saveCurrentAsTemplate(name);
    setSettingsRevision((n) => n + 1);
  };

  const submitSaveTemplate = async () => {
    const name = templateName.trim();
    if (!name) return;
    try {
      await saveCurrentTemplate(name);
      showToast(t("fw.template.saved", { name }), { kind: "success" });
      setSaveTemplateOpen(false);
      setTemplateName("");
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  };

  /** 模板确认：先保存当前现场再应用（用户不丢失当前工作区）。 */
  const saveThenApplyTemplate = async () => {
    if (!templatePending) return;
    const name = `${t("fw.template.autoPrefix")} ${new Date().toLocaleString()}`;
    try {
      await saveCurrentTemplate(name);
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
      return;
    }
    await applyCustomTemplate(templatePending.id);
  };

  // ── 打开文件夹（原生选择器 + 多种落点）────────────────────────────────
  const reportPickFailure = (result: Extract<PickFolderResult, { status: "invalid" }>) => {
    if (result.reason === "notFound") {
      setPickError(t("fw.pick.notFound", { path: result.path }));
    } else if (result.reason === "notDir") {
      setPickError(t("fw.pick.notDir", { path: result.path }));
    } else {
      setPickError(t("fw.pick.unreadable", { path: result.path, error: result.message ?? "" }));
    }
  };

  const openFolderAt = (paneId: string, path: string, mode: OpenFolderMode) => {
    const s = store.getState();
    s.recordRecentDir(path);
    if (mode === "replace") {
      s.openInPane(paneId, path, "replace");
      return true;
    }
    if (mode === "newTab") {
      const ok = s.openInPane(paneId, path, "newTab");
      if (!ok) showToast(t("fw.pane.tabLimit", { max: MAX_TABS_PER_PANE }), { kind: "warning" });
      return ok;
    }
    const direction: SplitDirection = mode === "left" || mode === "right" ? "horizontal" : "vertical";
    const side = mode === "left" || mode === "top" ? "before" : "after";
    return Boolean(s.splitPane(paneId, direction, path, side));
  };

  const browseFolder = async (paneId: string, mode: OpenFolderMode) => {
    if (pickBusy) return;
    setPickBusy(true);
    setPickError(null);
    try {
      const current =
        store.getState().panes[paneId]?.tabs.find(
          (x) => x.tabId === store.getState().panes[paneId]?.activeTabId,
        )?.path ?? "";
      const result = await pickFolder({ title: t("fw.dialog.openFolder"), defaultPath: current || project?.rootPath || undefined });
      if (result.status === "cancelled") return; // 取消：保持当前标签与布局不变
      if (result.status === "invalid") {
        reportPickFailure(result);
        showToast(
          result.reason === "notFound"
            ? t("fw.pick.notFound", { path: result.path })
            : result.reason === "notDir"
              ? t("fw.pick.notDir", { path: result.path })
              : t("fw.pick.unreadable", { path: result.path, error: result.message ?? "" }),
          { kind: "error" },
        );
        return;
      }
      openFolderAt(paneId, result.path, mode);
      setOpenFolder(null);
    } finally {
      setPickBusy(false);
    }
  };

  const submitOpenFolder = async () => {
    if (!openFolder) return;
    const typed = openFolderPath.trim();
    if (!typed) return;
    const result = await validateFolderPath(typed);
    if (result.status === "invalid") {
      reportPickFailure(result);
      return;
    }
    if (result.status !== "ok") return;
    openFolderAt(openFolder.paneId, result.path, openFolder.mode);
    setFolderPath("");
    setPickError(null);
    setOpenFolder(null);
  };

  const closeOtherPanes = (keepPaneId: string) => {
    const result = store.getState().closeOtherPanes(keepPaneId);
    if (result.status === "closed") return;
    if (result.reason === "capacity") {
      setCloseOthersBlocked(result.tabs.length);
      return;
    }
    showToast(t("fw.pane.closeFailed"), { kind: "warning" });
  };

  const paneCount = paneIds(tree).length;
  // 空窗格数量：用于布局菜单「关闭所有空窗格」的禁用判定。
  const emptyPaneCount = paneIds(tree).filter((id) => (panes[id]?.tabs.length ?? 0) === 0).length;
  const activeDir =
    panes[activePaneId]?.tabs.find((x) => x.tabId === panes[activePaneId]?.activeTabId)?.path ?? "";
  void activeDir;
  const selectedPaths = selectionMap[activePaneId]?.paths ?? [];

  /** 把当前窗格选中的文件/目录引用加入工作篮（不复制文件内容）。 */
  async function addSelectedToTray() {
    if (selectedPaths.length === 0) return;
    try {
      // 真实形态识别：目录 → directory、文件 → file、失效路径 → rejected，
      // 不能一律标成 file（否则发送时会用「复制文件」处理目录）。
      const resolved = await resolvePathInputs(selectedPaths, fsStat, "files");
      const report = resolved.inputs.length
        ? await useTransferStore.getState().add(resolved.inputs)
        : { added: 0, duplicates: 0, rejected: [], items: [] };
      const rejected = [...resolved.rejected, ...report.rejected];
      if (report.added === 0) {
        const first = rejected[0];
        showToast(
          first
            ? `加入工作篮失败：${first.title}：${first.message}`
            : "所选内容已全部在工作篮中",
          { kind: "error" },
        );
        return;
      }
      if (rejected.length > 0 || report.duplicates > 0) {
        showToast(
          `已加入 ${report.added} 项，${report.duplicates} 项重复，${rejected.length} 项被拒绝`,
          { kind: "warning" },
        );
      } else {
        showToast(`已加入工作篮 ${report.added} 项`, { kind: "success" });
      }
      useTransferStore.getState().openPanel();
    } catch (e) {
      showToast(`加入工作篮失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  const moreItems: DropdownMenuItem[] = [
    {
      key: "editLayout",
      label: layoutEditMode ? t("fw.layout.exitEdit") : t("fw.layout.edit"),
      icon: layoutEditMode ? <Check size={13} /> : <PenLine size={13} />,
      onSelect: () => store.getState().setLayoutEditMode(!layoutEditMode),
    },
    {
      // 窄内容区工具栏按钮被收纳后，模板抽屉仍可从这里打开（功能不丢）。
      key: "templates",
      label: t("fw.toolbar.templates"),
      icon: <LayoutPanelTop size={13} />,
      onSelect: () => {
        setDrawerAnchor("more");
        setLayoutOpen((v) => !v);
      },
    },
    {
      key: "saveLayout",
      label: t("fw.toolbar.saveLayout"),
      icon: <Save size={13} />,
      onSelect: () => setSaveTemplateOpen(true),
    },
    {
      key: "undo",
      label: t("fw.layout.undo"),
      icon: <Undo2 size={13} />,
      disabled: undoCount === 0,
      onSelect: () => {
        if (!store.getState().undoLayout()) showToast(t("fw.layout.nothingToUndo"), { kind: "info" });
      },
    },
    {
      key: "redo",
      label: t("fw.layout.redo"),
      icon: <Redo2 size={13} />,
      disabled: redoCount === 0,
      onSelect: () => {
        if (!store.getState().redoLayout()) showToast(t("fw.layout.nothingToRedo"), { kind: "info" });
      },
    },
    { key: "sep-history", separator: true },
    {
      key: "path",
      label: t("fw.layout.openByPath"),
      icon: <FolderSearch size={13} />,
      onSelect: () => {
        setFolderPath("");
        setPickError(null);
        setOpenFolder({ paneId: activePaneId, mode: "newTab" });
      },
    },
    { key: "maximize", label: maximizedPaneId ? t("fw.layout.restoreMax") : t("fw.layout.maximize"), icon: maximizedPaneId ? <Minimize2 size={13} /> : <Maximize2 size={13} />, disabled: paneCount <= 1, onSelect: () => store.getState().toggleMaximize(activePaneId) },
    { key: "closeOthers", label: t("fw.layout.closeOthers"), disabled: paneCount <= 1, onSelect: () => closeOtherPanes(activePaneId) },
    {
      // 空窗格批量清理：至少留一个窗格由 store 内部保证；无可清理时禁用。
      key: "closeEmptyPanes",
      label: t("fw.layout.closeEmptyPanes"),
      disabled: emptyPaneCount < 1 || paneCount <= 1,
      onSelect: () => {
        const n = store.getState().closeAllEmptyPanes();
        if (n > 0) showToast(t("fw.layout.closeEmptyPanesDone", { count: n }), { kind: "success" });
      },
    },
    { key: "sep-tools", separator: true },
    { key: "workspaceSearch", label: t("fw.search.workspace"), icon: <Search size={13} />, onSelect: () => setWorkspaceSearchOpen(true) },
    { key: "duplicates", label: t("fw.duplicates.find"), icon: <Files size={13} />, onSelect: () => setDuplicateOpen(true) },
    { key: "reset", label: t("fw.layout.resetDefault"), onSelect: () => applyLayoutPreset("single") },
    { key: "refreshAll", label: t("fw.layout.refreshAll"), onSelect: () => invalidateDirs(paneIds(tree).map((id) => panes[id]?.tabs.find((x) => x.tabId === panes[id]?.activeTabId)?.path ?? "").filter(Boolean)) },
  ];

  /** 模板菜单项：与快捷按钮、抽屉共用同一应用前确认入口（setTemplatePending）。 */
  const templateMenuItem = (tpl: { id: string; name: string }): DropdownMenuItem => ({
    key: tpl.id,
    label: tpl.name,
    icon: <LayoutGrid size={13} />,
    onSelect: () => setTemplatePending({ id: tpl.id, name: tpl.name }),
  });

  if (!hydrated) {
    return <div className="fw-root fw-root-boot" role="status" aria-label={t("nav.loading")} />;
  }

  return (
    <div className={`fw-root${source === "recycle" ? " is-recycle-source" : ""}`} ref={rootRef}>
      {/* 顶部工具栏（不重复 Shell 既有功能） */}
      <header className="fw-toolbar">
        <div className="fw-toolbar-title">
          <span className="fw-toolbar-glyph" aria-hidden="true">
            {source === "recycle" ? <Trash2 size={18} strokeWidth={1.75} /> : <FolderTree size={18} strokeWidth={1.75} />}
          </span>
          <span className="fw-toolbar-name">
            {source === "recycle" ? t("fw.recycle.title") : t("fw.title")}
          </span>
          {project && (
            <span className="fw-toolbar-project" data-tip={project.rootPath || undefined}>
              <FolderOpen size={12} aria-hidden="true" />
              {project.name}
            </span>
          )}
        </div>

        <div className="fw-source-switch" role="tablist" aria-label={t("fw.recycle.sourceSwitch")}>
          <button
            type="button"
            role="tab"
            aria-selected={source === "files"}
            className={`fw-source-btn${source === "files" ? " is-active" : ""}`}
            onClick={() => setSource("files")}
          >
            <FolderOpen size={12} aria-hidden="true" />
            {t("fw.recycle.sourceFiles")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === "recycle"}
            className={`fw-source-btn${source === "recycle" ? " is-active" : ""}`}
            onClick={() => setSource("recycle")}
          >
            <Trash2 size={12} aria-hidden="true" />
            {t("fw.recycle.sourceRecycle")}
          </button>
        </div>

        {/* 已保存布局模板的快捷入口：紧邻「文件 / 回收站」切换右侧，不新增工具栏行。
            最近使用优先取前 2 个；其余走紧凑菜单；无模板时整块不渲染（无空白占位）。 */}
        {persisted.templates.length > 0 && (
          <div className="fw-quick-templates" role="group" aria-label={t("fw.toolbar.templates")}>
            {quickTemplates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className="btn sm fw-quick-template"
                data-tip={tpl.name}
                onClick={() => setTemplatePending({ id: tpl.id, name: tpl.name })}
              >
                <LayoutGrid size={13} aria-hidden="true" />
                <span className="fw-quick-template-name">{tpl.name}</span>
              </button>
            ))}
            {remainingTemplates.length > 0 && (
              <DropdownMenu
                menuLabel={t("fw.toolbar.templates")}
                placement="bottom-start"
                trigger={({ ref, expanded, onClick, onKeyDown }) => (
                  <button
                    ref={ref}
                    type="button"
                    className="fw-icon-btn fw-quick-template-more"
                    aria-haspopup="menu"
                    aria-expanded={expanded}
                    aria-label={t("fw.toolbar.templates")}
                    data-tip={t("fw.toolbar.templates")}
                    onClick={onClick}
                    onKeyDown={onKeyDown}
                  >
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                )}
                items={remainingTemplates.map(templateMenuItem)}
              />
            )}
            {/* 窄内容区：快捷按钮与其余菜单收纳为单个「模板」图标菜单（CSS 控制显隐）。 */}
            <DropdownMenu
              menuLabel={t("fw.toolbar.templates")}
              placement="bottom-start"
              trigger={({ ref, expanded, onClick, onKeyDown }) => (
                <button
                  ref={ref}
                  type="button"
                  className="fw-icon-btn fw-quick-template-compact"
                  aria-haspopup="menu"
                  aria-expanded={expanded}
                  aria-label={t("fw.toolbar.templates")}
                  data-tip={t("fw.toolbar.templates")}
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                >
                  <LayoutPanelTop size={14} aria-hidden="true" />
                </button>
              )}
              items={persisted.templates.map(templateMenuItem)}
            />
          </div>
        )}

        <div className="fw-toolbar-actions">
          {/* 文件操作组：打开文件夹 / 加入工作篮 / 撤销 / 重做 */}
          <div className="fw-toolbar-group fw-toolbar-group--files">
          {/* 主操作：系统文件夹选择器 → 当前窗格新标签 */}
          <div className="fw-split-btn">
            <button
              type="button"
              className="btn sm fw-open-btn"
              disabled={pickBusy}
              onClick={() => void browseFolder(activePaneId, "newTab")}
            >
              <FolderPlus size={13} aria-hidden="true" />
              {t("fw.toolbar.addFolder")}
            </button>
            <DropdownMenu
              menuLabel={t("fw.toolbar.openMode")}
              placement="bottom-start"
              trigger={({ ref, expanded, onClick, onKeyDown }) => (
                <button
                  ref={ref}
                  type="button"
                  className="btn sm fw-open-caret"
                  aria-haspopup="menu"
                  aria-expanded={expanded}
                  aria-label={t("fw.toolbar.openMode")}
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                >
                  <ChevronDown size={13} aria-hidden="true" />
                </button>
              )}
              items={[
                { key: "replace", label: t("fw.openMode.replace"), onSelect: () => void browseFolder(activePaneId, "replace") },
                { key: "left", label: t("fw.openMode.left"), onSelect: () => void browseFolder(activePaneId, "left") },
                { key: "right", label: t("fw.openMode.right"), onSelect: () => void browseFolder(activePaneId, "right") },
                { key: "top", label: t("fw.openMode.top"), onSelect: () => void browseFolder(activePaneId, "top") },
                { key: "bottom", label: t("fw.openMode.bottom"), onSelect: () => void browseFolder(activePaneId, "bottom") },
                { key: "sep", separator: true },
                {
                  key: "path",
                  label: t("fw.openMode.byPath"),
                  onSelect: () => {
                    setFolderPath("");
                    setPickError(null);
                    setOpenFolder({ paneId: activePaneId, mode: "newTab" });
                  },
                },
              ]}
            />
          </div>

          {/* 跨模块入口：把当前选中项作为引用加入工作篮，不复制文件。 */}
          <button
            type="button"
            className="btn sm"
            disabled={selectedPaths.length === 0}
            data-tip="把当前窗格选中的文件/目录引用加入全局工作篮"
            onClick={() => void addSelectedToTray()}
          >
            <Archive size={13} aria-hidden="true" />
            <span className="fw-btn-label">加入工作篮</span>
          </button>

          <div className="fw-toolbar-group fw-toolbar-group--history" role="group" aria-label={t("fw.layout.history")}>
            <button
              type="button"
              className="fw-icon-btn"
              aria-label={t("fw.layout.undo")}
              data-tip={t("fw.layout.undo")}
              disabled={undoCount === 0}
              onClick={() => {
                if (!store.getState().undoLayout()) showToast(t("fw.layout.nothingToUndo"), { kind: "info" });
              }}
            >
              <Undo2 size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="fw-icon-btn"
              aria-label={t("fw.layout.redo")}
              data-tip={t("fw.layout.redo")}
              disabled={redoCount === 0}
              onClick={() => {
                if (!store.getState().redoLayout()) showToast(t("fw.layout.nothingToRedo"), { kind: "info" });
              }}
            >
              <Redo2 size={14} aria-hidden="true" />
            </button>
          </div>
          </div>

          {/* 布局操作组：当前布局 / 布局模板 / 保存为布局模板；模板入口紧邻布局切换入口 */}
          <div className="fw-toolbar-group fw-toolbar-group--layout" role="group" aria-label={t("fw.toolbar.layout")}>
          <DropdownMenu
            menuLabel={t("fw.layout.menu")}
            placement="bottom-start"
            trigger={({ ref, expanded, onClick, onKeyDown }) => (
              <button ref={ref} type="button" className="btn sm" aria-haspopup="menu" aria-expanded={expanded} onClick={onClick} onKeyDown={onKeyDown}>
                <LayoutGrid size={13} aria-hidden="true" />
                {t("fw.toolbar.layout")}
              </button>
            )}
            items={[
              { key: "single", label: t("fw.preset.single"), icon: <Square size={13} />, onSelect: () => applyLayoutPreset("single") },
              { key: "leftRight", label: t("fw.preset.leftRight"), icon: <Columns2 size={13} />, onSelect: () => applyLayoutPreset("leftRight") },
              { key: "topBottom", label: t("fw.preset.topBottom"), icon: <Rows2 size={13} />, onSelect: () => applyLayoutPreset("topBottom") },
              { key: "threeLeft", label: t("fw.preset.three"), icon: <Columns3 size={13} />, onSelect: () => applyLayoutPreset("threeLeft") },
              { key: "quad", label: t("fw.preset.quad"), icon: <LayoutGrid size={13} />, onSelect: () => applyLayoutPreset("quad") },
            ]}
          />

          <button
            ref={layoutBtnRef}
            type="button"
            className={`btn sm fw-hide-narrow${layoutOpen ? " is-on" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={layoutOpen}
            onClick={(e) => {
              e.stopPropagation();
              setDrawerAnchor("toolbar");
              setLayoutOpen((v) => !v);
            }}
          >
            <LayoutPanelTop size={13} aria-hidden="true" />
            {t("fw.toolbar.templates")}
          </button>

          <button type="button" className="btn sm fw-hide-narrow" onClick={() => setSaveTemplateOpen(true)}>
            <Save size={13} aria-hidden="true" />
            {t("fw.toolbar.saveLayout")}
          </button>
          </div>

          {/* 其他组：低频操作；窄窗被收纳的模板/存为模板/撤销重做在此兜底 */}
          <div className="fw-toolbar-group fw-toolbar-group--more">
          <DropdownMenu
            menuLabel={t("fw.toolbar.more")}
            placement="bottom-end"
            trigger={({ ref, expanded, onClick, onKeyDown }) => (
              <button
                ref={(el) => {
                  ref(el);
                  moreBtnRef.current = el as HTMLButtonElement | null;
                }}
                type="button"
                className="fw-icon-btn"
                aria-haspopup="menu"
                aria-expanded={expanded}
                aria-label={t("fw.toolbar.more")}
                onClick={onClick}
                onKeyDown={onKeyDown}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </button>
            )}
            items={moreItems}
          />
          </div>
        </div>
      </header>

      {/* 布局编辑模式：只在编辑期间占用一条窄提示栏，退出即恢复普通浏览 */}
      {layoutEditMode && (
        <div className="fw-edit-banner" role="status">
          <PenLine size={13} aria-hidden="true" />
          <span>{t("fw.edit.banner")}</span>
          <button type="button" className="btn sm" onClick={() => store.getState().setLayoutEditMode(false)}>
            {t("fw.edit.exit")}
          </button>
        </div>
      )}

      {/* 主区域：普通文件分割树 / 回收站数据源（同一外壳，独立权限） */}
      <div className="fw-workarea">
        {source === "recycle" ? (
          <Suspense fallback={<div className="fw-pane-loading" role="status" />}>
            <RecycleWorkspaceView />
          </Suspense>
        ) : maximizedPaneId && panes[maximizedPaneId] ? (
          <SplitRender
            node={{ type: "pane", paneId: maximizedPaneId }}
            pageActive={pageActive}
            maximizedPaneId={maximizedPaneId}
            dropHintPane={dropHint?.paneId ?? null}
            dropHint={dropHint}
            onHoverZone={onHoverZone}
            layoutEditMode={false}
            projectRoot={project?.rootPath ?? null}
          />
        ) : (
          <SplitRender
            node={tree}
            pageActive={pageActive}
            maximizedPaneId={null}
            dropHintPane={dropHint?.paneId ?? null}
            dropHint={dropHint}
            onHoverZone={onHoverZone}
            layoutEditMode={layoutEditMode}
            projectRoot={project?.rootPath ?? null}
          />
        )}
      </div>

      {/* 布局抽屉（非侵入 Popover） */}
      <Popover
        open={layoutOpen}
        onOpenChange={setLayoutOpen}
        anchorRef={drawerAnchorRef ?? layoutBtnRef}
        positionOverride={drawerPositionOverride}
        placement="bottom-end"
        className="fw-layout-pop"
        role="dialog"
      >
        <div className="fw-layout-drawer" onPointerDown={(e) => e.stopPropagation()}>
          <div className="fw-drawer-section">
            <h3 className="fw-drawer-title">{t("fw.layout.presets")}</h3>
            <p className="fw-drawer-hint">{t("fw.layout.presetsHint")}</p>
            <div className="fw-preset-grid">
              {Object.values(LAYOUT_PRESETS).map((preset) => (
                <button key={preset.id} type="button" className="fw-preset-item" onClick={() => applyLayoutPreset(preset.id)}>
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="fw-drawer-section">
            <h3 className="fw-drawer-title">{t("fw.layout.editSection")}</h3>
            <p className="fw-drawer-hint">{t("fw.layout.editHint")}</p>
            <div className="fw-drawer-actions">
              <button
                type="button"
                className={`btn sm${layoutEditMode ? " primary" : ""}`}
                onClick={() => store.getState().setLayoutEditMode(!layoutEditMode)}
              >
                {layoutEditMode ? <Check size={12} aria-hidden="true" /> : <PenLine size={12} aria-hidden="true" />}
                {layoutEditMode ? t("fw.layout.exitEdit") : t("fw.layout.edit")}
              </button>
              <button type="button" className="btn sm" disabled={undoCount === 0} onClick={() => store.getState().undoLayout()}>
                <Undo2 size={12} aria-hidden="true" />
                {t("fw.layout.undo")}
              </button>
              <button type="button" className="btn sm" disabled={redoCount === 0} onClick={() => store.getState().redoLayout()}>
                <Redo2 size={12} aria-hidden="true" />
                {t("fw.layout.redo")}
              </button>
            </div>
          </div>

          {stashed.length > 0 && (
            <div className="fw-drawer-section">
              <h3 className="fw-drawer-title">
                {t("fw.layout.stashTitle")} · {stashed.length}
              </h3>
              <p className="fw-drawer-hint">{t("fw.layout.stashHint")}</p>
              <div className="fw-template-list">
                {stashed.map((item) => (
                  <button
                    key={item.tabId}
                    type="button"
                    className="fw-template-item"
                    title={item.path}
                    onClick={() => {
                      const ok = store.getState().restoreStashedTab(item.tabId);
                      if (!ok) showToast(t("fw.layout.stashFull"), { kind: "warning" });
                    }}
                  >
                    <FolderOpen size={13} aria-hidden="true" />
                    <span className="fw-template-name">{basename(item.path) || item.path}</span>
                    <span className="fw-stash-restore">{t("fw.layout.stashRestore")}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {persisted.templates.length > 0 && (
            <div className="fw-drawer-section">
              <h3 className="fw-drawer-title">{t("fw.layout.myTemplates")}</h3>
              <p className="fw-drawer-hint">{t("fw.layout.templatesHint")}</p>
              <div className="fw-template-list">
                {persisted.templates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className="fw-template-item"
                    onClick={() => setTemplatePending({ id: tpl.id, name: tpl.name })}
                  >
                    <LayoutGrid size={14} aria-hidden="true" />
                    <span className="fw-template-name">{tpl.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="fw-drawer-foot">
            <button type="button" className="btn sm primary" onClick={() => setSaveTemplateOpen(true)}>
              <Plus size={12} aria-hidden="true" />
              {t("fw.layout.saveCurrent")}
            </button>
          </div>
        </div>
      </Popover>

      {/* 打开文件夹对话框：路径输入内嵌系统选择器为主操作，最近/固定/常用位置为辅 */}
      <Dialog
        open={openFolder !== null}
        onClose={() => setOpenFolder(null)}
        title={t("fw.dialog.openFolder")}
        size="sm"
        ariaLabel={t("fw.dialog.openFolder")}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setOpenFolder(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!openFolderPath.trim()}
              onClick={() => void submitOpenFolder()}
            >
              {t("fw.dialog.openByPath")}
            </button>
          </>
        }
      >
        <div className="fw-open-folder">
          <div className="fw-open-modes" role="radiogroup" aria-label={t("fw.toolbar.openMode")}>
            {(
              [
                ["newTab", t("fw.openMode.newTab")],
                ["replace", t("fw.openMode.replace")],
                ["left", t("fw.openMode.left")],
                ["right", t("fw.openMode.right")],
                ["top", t("fw.openMode.top")],
                ["bottom", t("fw.openMode.bottom")],
              ] as Array<[OpenFolderMode, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={openFolder?.mode === mode}
                className={`fw-mode-chip${openFolder?.mode === mode ? " is-on" : ""}`}
                onClick={() => setOpenFolder((prev) => (prev ? { ...prev, mode } : prev))}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 目录路径与「浏览文件夹」合成同一个输入框：按钮是输入框内的后缀动作，
              左侧仍是完整可键入的绝对路径输入区（回车直接打开）。 */}
          <div className="fw-dialog-field">
            <span id="fw-open-folder-path-label">{t("fw.dialog.folderPath")}</span>
            <div className="fw-path-field">
              <input
                className="fw-path-input"
                aria-labelledby="fw-open-folder-path-label"
                value={openFolderPath}
                placeholder={t("fw.dialog.folderPlaceholder")}
                onChange={(e) => {
                  setFolderPath(e.target.value);
                  setPickError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitOpenFolder();
                }}
              />
              <button
                type="button"
                className="fw-path-browse"
                disabled={pickBusy || !openFolder}
                onClick={() => openFolder && void browseFolder(openFolder.paneId, openFolder.mode)}
              >
                <FolderSearch size={12} aria-hidden="true" />
                {pickBusy ? t("fw.dialog.browsing") : t("fw.dialog.browse")}
              </button>
            </div>
          </div>

          {pickError && (
            <p className="fw-pick-error" role="alert">
              <AlertTriangle size={12} aria-hidden="true" />
              {pickError}
            </p>
          )}

          {recentDirs.length > 0 && (
            <div className="fw-dir-section">
              <span className="fw-empty-label">{t("fw.pane.recentDirs")}</span>
              {recentDirs.map((path) => (
                <DirRow
                  key={path}
                  path={path}
                  pinned={pinnedDirs.some((p) => p.toLowerCase() === path.toLowerCase())}
                  onOpen={() => {
                    if (openFolder) openFolderAt(openFolder.paneId, path, openFolder.mode);
                    setOpenFolder(null);
                  }}
                  onPin={() => store.getState().togglePinnedDir(path)}
                />
              ))}
            </div>
          )}

          {pinnedDirs.length > 0 && (
            <div className="fw-dir-section">
              <span className="fw-empty-label">{t("fw.pane.pinnedDirs")}</span>
              {pinnedDirs.map((path) => (
                <DirRow
                  key={path}
                  path={path}
                  pinned
                  onOpen={() => {
                    if (openFolder) openFolderAt(openFolder.paneId, path, openFolder.mode);
                    setOpenFolder(null);
                  }}
                  onPin={() => store.getState().togglePinnedDir(path)}
                />
              ))}
            </div>
          )}

          {project?.rootPath && (
            <div className="fw-dir-section">
              <span className="fw-empty-label">{t("fw.pane.projectRoot")}</span>
              <DirRow
                path={project.rootPath}
                name={project.name}
                pinned={pinnedDirs.some((p) => p.toLowerCase() === project.rootPath!.toLowerCase())}
                onOpen={() => {
                  if (openFolder) openFolderAt(openFolder.paneId, project.rootPath!, openFolder.mode);
                  setOpenFolder(null);
                }}
                onPin={() => store.getState().togglePinnedDir(project.rootPath!)}
              />
            </div>
          )}

          {places.length > 0 && (
            <div className="fw-dir-section">
              <span className="fw-empty-label">{t("fw.dialog.quickPlaces")}</span>
              {places.map((place) => (
                <DirRow
                  key={place.path}
                  path={place.path}
                  name={place.name}
                  pinned={pinnedDirs.some((p) => p.toLowerCase() === place.path.toLowerCase())}
                  onOpen={() => {
                    if (openFolder) openFolderAt(openFolder.paneId, place.path, openFolder.mode);
                    setOpenFolder(null);
                  }}
                  onPin={() => store.getState().togglePinnedDir(place.path)}
                />
              ))}
            </div>
          )}
        </div>
      </Dialog>

      {/* 保存模板 */}
      <Dialog
        open={saveTemplateOpen}
        onClose={() => setSaveTemplateOpen(false)}
        title={t("fw.template.saveTitle")}
        size="sm"
        ariaLabel={t("fw.template.saveTitle")}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setSaveTemplateOpen(false)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary" disabled={!templateName.trim()} onClick={() => void submitSaveTemplate()}>
              {t("common.confirm")}
            </button>
          </>
        }
      >
        <label className="fw-dialog-field">
          <span>{t("fw.template.name")}</span>
          <input
            className="ws-input"
            value={templateName}
            autoFocus
            placeholder={t("fw.template.namePlaceholder")}
            onChange={(e) => setTemplateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitSaveTemplate();
            }}
          />
        </label>
        <p className="fw-template-hint">{t("fw.template.saveHint")}</p>
      </Dialog>

      {/* 键盘 Delete 确认（回收站；Shift+Delete = 永久删除独立确认） */}
      <ConfirmDialog
        open={deleteOpen}
        title={
          deletePermanent
            ? t("fw.dialog.deletePermanentTitle", { count: deletePathsRef.current.length })
            : t("fw.dialog.deleteTitle", { count: deletePathsRef.current.length })
        }
        detail={deletePermanent ? t("fw.dialog.deletePermanentBody") : t("fw.dialog.deleteBody")}
        confirmLabel={deletePermanent ? t("fw.dialog.deletePermanentConfirm") : t("fw.dialog.deleteConfirm")}
        danger
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          const paths = [...deletePathsRef.current];
          const permanent = deletePermanent;
          setDeleteOpen(false);
          setDeletePermanent(false);
          void (async () => {
            // 与拖拽/分栏菜单同一套语义：前端生成 operation_id，Rust 按同一 ID
            // 写权威业务结果；这里只做结果展示，不重复上报同一故障。
            const op = startOperation("file", "workspace_delete", {
              component: "文件工作区",
              metadata: { count: paths.length, permanent },
            });
            try {
              op.stage("job");
              // 与 FilePane 同一路径：删除交给统一任务服务，进度与取消由队列条呈现。
              const job = await fsDeleteJobStart(paths, permanent, op.id);
              const final = await waitForFileJob(job.id);
              invalidateDirs(paths.map((p) => parentOf(p) ?? "").filter(Boolean));
              const result = showFileJobOutcome({
                effect: permanent ? "deletePermanent" : "deleteRecycle",
                job: final,
                t,
                showToast,
              });
              if (result === "ok") op.success({ metadata: { total: job.total } });
              else {
                op.fail(
                  {
                    code: final?.failures[0]?.code ?? "FS_OP_CANCELLED",
                    message: t("fw.queue.unfinished"),
                  },
                  { stage: "job", severity: "WARN" },
                );
              }
              store.getState().clearSelection(store.getState().activePaneId);
            } catch (e) {
              showToast(errorMessage(e), { kind: "error" });
            }
          })();
        }}
      />

      {/* 应用工作区模板：明确说明会替换当前工作现场，并允许先保存当前状态 */}
      <Dialog
        open={templatePending !== null}
        onClose={() => setTemplatePending(null)}
        title={t("fw.template.applyTitle", { name: templatePending?.name ?? "" })}
        size="sm"
        ariaLabel={t("fw.template.applyTitle", { name: templatePending?.name ?? "" })}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setTemplatePending(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn" onClick={() => void saveThenApplyTemplate()}>
              {t("fw.template.saveThenApply")}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                if (templatePending) void applyCustomTemplate(templatePending.id);
              }}
            >
              {t("fw.template.applyConfirm")}
            </button>
          </>
        }
      >
        <p>{t("fw.template.applyBody")}</p>
        <p className="fw-template-hint">{t("fw.template.applyUndoHint")}</p>
      </Dialog>

      {/* 关闭其他区域容量不足：明确选择收纳或取消（不得静默丢弃） */}
      <Dialog
        open={closeOthersBlocked !== null}
        onClose={() => setCloseOthersBlocked(null)}
        title={t("fw.dialog.closeOthersBlockedTitle")}
        size="sm"
        ariaLabel={t("fw.dialog.closeOthersBlockedTitle")}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setCloseOthersBlocked(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                const result = store.getState().closeOtherPanes(activePaneId, { mode: "stash" });
                setCloseOthersBlocked(null);
                if (result.status === "closed") {
                  showToast(t("fw.pane.closeStashed", { count: result.stashedTabs }), { kind: "info" });
                } else {
                  showToast(t("fw.pane.closeFailed"), { kind: "error" });
                }
              }}
            >
              {t("fw.dialog.closePaneStash", { count: closeOthersBlocked ?? 0 })}
            </button>
          </>
        }
      >
        <p>{t("fw.dialog.closeOthersBlockedBody", { count: closeOthersBlocked ?? 0 })}</p>
      </Dialog>

      {/* 传输目标选择器：列出已打开窗格（名称/目录/是否活动），单窗格不显示入口 */}
      <Dialog
        open={transferPicker !== null}
        onClose={() => setTransferPicker(null)}
        title={
          transferPicker?.effect === "move"
            ? t("fw.quick.pickerMoveTitle")
            : t("fw.quick.pickerCopyTitle")
        }
        size="md"
        ariaLabel={t("fw.quick.pickerAria")}
        footer={
          <button type="button" className="btn" onClick={() => setTransferPicker(null)}>
            {t("common.cancel")}
          </button>
        }
      >
        {transferPicker && (
          <>
            <p className="fw-transfer-summary">
              {transferPicker.effect === "move"
                ? t("fw.quick.moveSummary", { count: transferPicker.paths.length })
                : t("fw.quick.copySummary", { count: transferPicker.paths.length })}
            </p>
            <div className="fw-transfer-targets">
              {paneTargets
                .filter((target) => target.paneId !== transferPicker.sourcePaneId)
                .map((target) => (
                  <button
                    key={target.paneId}
                    type="button"
                    className={`fw-transfer-target${target.active ? " is-active" : ""}`}
                    onClick={() => {
                      const pending = transferPicker;
                      setTransferPicker(null);
                      lastTransferTargetRef.current = target.paneId;
                      void requestTransfer(pending.paths, target.dir, pending.effect);
                    }}
                  >
                    <span className="fw-transfer-target-icon" aria-hidden="true">
                      {transferPicker.effect === "move" ? <Move size={16} /> : <Copy size={16} />}
                    </span>
                    <span className="fw-transfer-target-main">
                      <span className="fw-transfer-target-name">
                        {target.label}
                        {target.active && <span className="fw-transfer-active">{t("fw.quick.activePane")}</span>}
                      </span>
                      <span className="fw-transfer-target-path" title={target.dir}>
                        {target.dir}
                      </span>
                    </span>
                  </button>
                ))}
            </div>
          </>
        )}
      </Dialog>

      {/* 批量冲突：只决策一次，策略统一应用于整批；默认“保留两者”不覆盖 */}
      <Dialog
        open={conflictPending !== null}
        onClose={() => setConflictPending(null)}
        title={t("fw.conflict.title", { count: conflictPending?.conflicts.length ?? 0 })}
        size="md"
        ariaLabel={t("fw.conflict.aria")}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConflictPending(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const pending = conflictPending;
                setConflictPending(null);
                if (!pending) return;
                void applyFileDrop(pending.paths, pending.targetDir, pending.effect, "skip").then((report) =>
                  pending.after?.(report),
                );
              }}
            >
              {t("fw.conflict.skip")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const pending = conflictPending;
                setConflictPending(null);
                if (!pending) return;
                void applyFileDrop(pending.paths, pending.targetDir, pending.effect, "overwrite").then((report) =>
                  pending.after?.(report),
                );
              }}
            >
              {t("fw.conflict.replace")}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                const pending = conflictPending;
                setConflictPending(null);
                if (!pending) return;
                void applyFileDrop(pending.paths, pending.targetDir, pending.effect, "rename").then((report) =>
                  pending.after?.(report),
                );
              }}
            >
              {t("fw.conflict.keepBoth")}
            </button>
          </>
        }
      >
        {conflictPending && (
          <>
            <p>{t("fw.conflict.body", { target: conflictPending.targetDir })}</p>
            <p className="fw-template-hint">{t("fw.conflict.applyAll")}</p>
            <ul className="fw-conflict-list">
              {conflictPending.conflicts.slice(0, 6).map((conflict) => (
                <li key={conflict.target}>
                  <span className="fw-conflict-name">{basename(conflict.source)}</span>
                  <span className="fw-conflict-kind">
                    {conflict.targetKind === "dir"
                      ? t("fw.conflict.kindDir")
                      : conflict.targetKind === "link"
                        ? t("fw.conflict.kindLink")
                        : t("fw.conflict.kindFile")}
                  </span>
                </li>
              ))}
            </ul>
            {conflictPending.conflicts.length > 6 && (
              <p className="fw-template-hint">
                {t("fw.conflict.more", { count: conflictPending.conflicts.length - 6 })}
              </p>
            )}
          </>
        )}
      </Dialog>

      <OperationPreviewDialog
        request={
          previewPending
            ? {
                preview: previewPending.preview,
                onConfirm: confirmPreview,
                onCancel: () => setPreviewPending(null),
              }
            : null
        }
      />
      <BatchRenameDialog request={batchRenameRequest} onClose={() => setBatchRenameRequest(null)} />
      <FolderCompareDialog
        request={compareRequest}
        onClose={() => setCompareRequest(null)}
        onCopy={(paths, targetDir) => applyFileDrop(paths, targetDir, "copy", "rename")}
      />
      <QuickPreviewDialog request={previewRequest} onClose={() => setPreviewRequest(null)} />
      <WorkspaceSearchDialog
        open={workspaceSearchOpen}
        sources={workspaceSearchSources}
        onClose={() => setWorkspaceSearchOpen(false)}
        onReveal={revealSearchHit}
      />
      <DuplicateFinderDialog
        open={duplicateOpen}
        sources={searchSources}
        onClose={() => setDuplicateOpen(false)}
        onReveal={revealSearchHit}
        onDelete={deleteDuplicatePaths}
      />
      <OperationQueueBar />
      {source === "files" && <FwCutBanner />}
      <FwDragGhost />
    </div>
  );
}

/** 拖拽 ghost：显示操作类型/数量/允许与否，独立订阅拖拽状态（不牵动面板树）。 */
function FwDragGhost() {
  const { t } = useLocale();
  const [st, setSt] = useState(() => getFwDragState());
  useEffect(() => subscribeFwDrag(setSt), []);
  if (!st.payload) return null;
  const paneLabel = (paneId: string): string => {
    const s = useFilesWorkspaceStore.getState();
    const pane = s.panes[paneId];
    const tab = pane?.tabs.find((x) => x.tabId === pane.activeTabId);
    return tab ? tabTitle(tab) : t("fw.drag.emptyPane");
  };
  const firstTabLabel = (): string => {
    const payload = st.payload;
    if (payload?.kind !== "tabs") return "";
    const s = useFilesWorkspaceStore.getState();
    const pane = s.panes[payload.fromPaneId];
    const tab = pane?.tabs.find((x) => x.tabId === payload.tabIds[0]);
    return tab ? tabTitle(tab) : "";
  };

  let text = "";
  let denied = false;
  if (st.payload.kind === "pane") {
    const target = st.hover?.type === "pane-swap" ? st.hover.paneId : null;
    denied = !target || target === st.payload.fromPaneId;
    text = target && !denied
      ? t("fw.drag.paneSwap", { from: paneLabel(st.payload.fromPaneId), to: paneLabel(target) })
      : t("fw.drag.paneHint");
  } else if (st.payload.kind === "tabs") {
    const zone = st.hover;
    denied = !zone;
    if (!zone) {
      text = t("fw.drag.tabDenied", { name: firstTabLabel() });
    } else if (zone.type === "edge") {
      const zoneName =
        zone.edge === "left" ? t("fw.drag.zoneLeft")
          : zone.edge === "right" ? t("fw.drag.zoneRight")
            : zone.edge === "top" ? t("fw.drag.zoneTop")
              : t("fw.drag.zoneBottom");
      text = t("fw.drag.tabSplit", { name: firstTabLabel(), zone: zoneName });
    } else if (zone.type === "tabbar" && zone.paneId === st.payload.fromPaneId) {
      text = t("fw.drag.tabReorder", { name: firstTabLabel() });
    } else {
      text = t("fw.drag.tabMerge", { name: firstTabLabel(), target: paneLabel(zone.paneId) });
    }
  } else {
    denied = !st.hover;
    const targetDir =
      st.hover?.type === "folder"
        ? st.hover.path
        : st.hover?.type === "center"
          ? st.hover.dir
          : null;
    const targetPaneId =
      st.hover?.type === "folder" || st.hover?.type === "center" ? st.hover.paneId : null;
    if (!targetDir || !targetPaneId) {
      text = t("fw.drag.fileDenied", { count: st.payload.paths.length });
      denied = true;
    } else {
      text =
        st.effect === "copy"
          ? t("fw.drag.copyTo", {
              count: st.payload.paths.length,
              target: basename(targetDir),
              pane: paneLabel(targetPaneId),
            })
          : t("fw.drag.moveTo", {
              count: st.payload.paths.length,
              target: basename(targetDir),
              pane: paneLabel(targetPaneId),
            });
    }
  }
  return (
    <div
      className={`fw-drag-ghost${st.payload.kind !== "files" ? " is-tabs" : ""}${denied ? " is-denied" : ""}`}
      style={{ left: st.x, top: st.y }}
      aria-hidden="true"
    >
      {text}
    </div>
  );
}

/** 其他模块 / 未来 Agent 的显式入口：在活动窗格打开指定目录（新标签，不切页）。 */
export function openFilesWorkspacePath(path: string): void {
  openDirInFilesWorkspace(path, false);
}

/**
 * 剪切状态横幅（FW-FILE-004）：剪切后全局可见的「已剪切 N 项 + 取消剪切」入口。
 * 只展示与清理 TaskDock 内部剪贴板——不触碰真实文件，也不写系统剪贴板；
 * 订阅 interactions.ts 的唯一剪贴板状态（useFwClipboard），不建第二份。
 */
function FwCutBanner() {
  const { t } = useLocale();
  const clipboard = useFwClipboard();
  if (!clipboard || clipboard.mode !== "cut") return null;
  return (
    <div className="fw-cut-banner" role="status">
      <Scissors size={13} aria-hidden="true" />
      <span>{t("fw.cut.banner", { count: clipboard.paths.length })}</span>
      <button
        type="button"
        className="btn sm"
        onClick={() => clearFwClipboard()}
        aria-label={t("fw.cut.clear")}
        data-tip={t("fw.cut.clear")}
      >
        {t("fw.cut.clear")}
      </button>
    </div>
  );
}

/**
 * 文件工作区上下文（§9.4 Agent 接口预留）：只暴露活动窗格目录与用户选择，
 * 不读取任何文件夹内容；写入/删除类操作必须走既有授权与确认 UI。
 */
export function getFilesWorkspaceContext(): {
  activePaneId: string;
  activeDir: string | null;
  selection: string[];
} {
  const s = useFilesWorkspaceStore.getState();
  const pane = s.panes[s.activePaneId];
  const dir = pane?.tabs.find((x) => x.tabId === pane.activeTabId)?.path ?? null;
  return {
    activePaneId: s.activePaneId,
    activeDir: dir,
    selection: s.selection[s.activePaneId]?.paths ?? [],
  };
}
