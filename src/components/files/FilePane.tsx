//! 文件工作区单分栏：标签栏 / 导航工具栏 / 面包屑 / 列表 / 状态条 / 右键菜单。
//!
//! 每个区域是独立的文件浏览器（任务规范 §5）：当前路径、历史、视图、排序、
//! 搜索、选择、加载状态全部来自 store 中本窗格的标签，区域间互不影响。
//! 交互通道分离：外部 OS 拖入走 fileDrop 仲裁（data-fw-accept 命中），
//! 应用内拖拽走 fwDrag 协调器（标签→分栏/合并、文件→目录/文件夹行）。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GripVertical,
  List as ListIcon,
  LayoutGrid,
  Plus,
  RotateCcw,
  Search,
  X,
  Eye,
  EyeOff,
  MoreHorizontal,
  FolderOpen,
  FolderPlus,
  Copy,
  Move,
  Send,
  ClipboardCopy,
  ExternalLink,
  GitCompare,
  ListChecks,
  Filter,
} from "lucide-react";

import DropdownMenu from "../ui/DropdownMenu";
import { ConfirmDialog, Dialog } from "../ui/Dialog";
import FileList from "./FileList";
import { useLocale } from "../../hooks/useLocale";
import { errorMessage } from "../../lib/errors";
import { copyText } from "../../lib/clipboard";
import { isLogged, startOperation } from "../../lib/diagnostics";
import { showFsOpOutcome } from "./fsOpFeedback";
import {
  loadDir,
  loadMore,
  reloadIfChanged,
  subscribeDir,
  getDirState,
  type DirState,
} from "../../lib/filesWorkspace/dirCache";
import { formatSize, CATEGORY_LABEL } from "../../lib/filesWorkspace/fileMeta";
import { basename, breadcrumbSegments, joinPath, normalizePath, parentOf } from "../../lib/filesWorkspace/pathUtils";
import { filterTransferablePaths } from "../../lib/filesWorkspace/transfer";
import { pickFolder, type PickFolderResult } from "../../lib/filesWorkspace/folderPicker";
import { MAX_TABS_PER_PANE, pathToPane } from "../../lib/filesWorkspace/model";
import {
  isFwDragging,
  startFwDrag,
  subscribeFwDrag,
  updateFwHover,
  sameZone,
  validateFileDrop,
  getFwDragState,
  getFwClipboard,
  setFwClipboard,
  type FwDropZone,
} from "../../lib/filesWorkspace/interactions";
import {
  fsCopyPaths,
  fsMovePaths,
  fsDeletePaths,
  fsOpen,
  fsReveal,
  fsStat,
  fsCreateDir,
  fsCreateFile,
  fsRename,
  shelfAddPaths,
  type FsEntry,
  type FsOpReport,
  type FsStat,
} from "../../lib/bridge";
import { useFilesWorkspaceStore, tabTitle, type FileFilter, type FolderTab } from "../../store/useFilesWorkspaceStore";
import { useUiStore } from "../../store/useUiStore";

const POLL_INTERVAL_MS = 4000;
const DRAG_THRESHOLD_PX = 6;

interface Props {
  paneId: string;
  active: boolean;
  /** 整页是否可见（路由激活）：轮询只在可见时进行。 */
  pageActive: boolean;
  /** 本窗格解析出的拖拽落点变化（供中心/边缘/文件夹行高亮）。 */
  onHoverZone: (zone: FwDropZone | null) => void;
  dropHint: FwDropZone | null;
  /** 布局编辑模式：只允许区域拖拽（交换位置），暂停文件/标签拖拽。 */
  layoutEditMode: boolean;
  /** 当前项目根目录（空窗格「从当前项目打开」用；无项目时为 null）。 */
  projectRoot?: string | null;
}

interface PendingOp {
  kind: "newDir" | "newFile" | "rename" | "delete";
  path?: string;
}

/** 自由定位菜单：复用 DropdownMenu 基元，用零尺寸固定定位触发器自动展开。 */
function FreeMenu({
  x,
  y,
  items,
  menuLabel,
  onClose,
}: {
  x: number;
  y: number;
  items: ReadonlyArray<{
    key: string;
    label: string;
    icon?: React.ReactNode;
    disabled?: boolean;
    danger?: boolean;
    radio?: boolean;
    checked?: boolean;
    onSelect?: () => void;
  }>;
  menuLabel: string;
  onClose: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    triggerRef.current?.click();
  }, []);
  const anchorStyle: React.CSSProperties = {
    position: "fixed",
    left: x,
    top: y,
    width: 0,
    height: 0,
    opacity: 0,
    pointerEvents: "none",
    border: 0,
    padding: 0,
  };
  return (
    <DropdownMenu
      menuLabel={menuLabel}
      placement="bottom-start"
      trigger={({ ref, onClick, onKeyDown }) => (
        <button
          ref={(el) => {
            triggerRef.current = el;
            if (typeof ref === "function") ref(el);
          }}
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          style={anchorStyle}
          onClick={onClick}
          onKeyDown={onKeyDown}
        />
      )}
      items={items}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    />
  );
}

/**
 * 布局编辑模式的区域把手：拖动交换位置（指针），方向键微调最近一层分割比例（键盘）。
 * 只在编辑模式渲染——普通浏览模式没有整窗格拖拽，杜绝“移动整个窗格（0 个标签）”。
 */
function EditHandle({
  paneId,
  onPointerDown,
}: {
  paneId: string;
  onPointerDown: (e: ReactPointerEvent) => void;
}) {
  const { t } = useLocale();
  const nudge = (direction: "left" | "right" | "up" | "down") => {
    const path = pathToPane(useFilesWorkspaceStore.getState().tree, paneId);
    if (!path || path.length === 0) return;
    const horizontal = direction === "left" || direction === "right";
    const split = [...path].reverse().find((node) => node.direction === (horizontal ? "horizontal" : "vertical"));
    if (!split) return;
    const delta = direction === "left" || direction === "up" ? -0.02 : 0.02;
    const next = Math.min(0.85, Math.max(0.15, split.ratio + delta));
    useFilesWorkspaceStore.getState().updateRatio(split.id, next);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const map = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    } as const;
    const direction = map[e.key as keyof typeof map];
    if (!direction) return;
    e.preventDefault();
    nudge(direction);
  };
  return (
    <div
      className="fw-edit-handle"
      role="button"
      tabIndex={0}
      aria-label={t("fw.edit.dragTip")}
      data-tip={t("fw.edit.dragTip")}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <GripVertical size={13} aria-hidden="true" />
      <span>{t("fw.edit.dragShort")}</span>
    </div>
  );
}

/**
 * 拖拽落点预览：细边框 + 半透明方向区域 + 小标签，替代原先 5px 紫色粗条。
 * 预览只表达「松手会发生什么」，不遮挡目录内容（方向区最多 38% 且半透明）。
 */
function DropPreview({ zone }: { zone: FwDropZone }) {
  const { t } = useLocale();
  // 拖拽过程中 Ctrl/Shift 变化不改变落点，但会改变语义；订阅快照让标签即时刷新。
  const drag = useSyncExternalStore(subscribeFwDrag, getFwDragState);
  if (zone.type === "edge") {
    const label =
      zone.edge === "left"
        ? t("fw.drag.splitLeft")
        : zone.edge === "right"
          ? t("fw.drag.splitRight")
          : zone.edge === "top"
            ? t("fw.drag.splitTop")
            : t("fw.drag.splitBottom");
    return (
      <div className={`fw-drop-preview fw-drop-${zone.edge}`} aria-hidden="true">
        <span className="fw-drop-shade" />
        <span className="fw-drop-label">{label}</span>
      </div>
    );
  }
  if (zone.type === "pane-swap") {
    return (
      <div className="fw-drop-preview fw-drop-swap" aria-hidden="true">
        <span className="fw-drop-label">
          <ArrowLeftRight size={12} aria-hidden="true" />
          {t("fw.drag.swapHint")}
        </span>
      </div>
    );
  }
  if (zone.type === "center") {
    const st = drag;
    if (st.payload?.kind === "files") {
      const accepted = filterTransferablePaths(st.payload.paths, zone.dir);
      if (!accepted.length) {
        return (
          <div className="fw-drop-preview fw-drop-center is-invalid" aria-hidden="true">
            <span className="fw-drop-label">{t("fw.quick.alreadyHere")}</span>
          </div>
        );
      }
      return (
        <div className="fw-drop-preview fw-drop-center" aria-hidden="true">
          <span className="fw-drop-label">
            {st.effect === "copy"
              ? t("fw.drag.copyHereCount", {
                  count: accepted.length,
                  target: basename(zone.dir),
                })
              : t("fw.drag.moveHereCount", {
                  count: accepted.length,
                  target: basename(zone.dir),
                })}
          </span>
        </div>
      );
    }
    return (
      <div className="fw-drop-preview fw-drop-center" aria-hidden="true">
        <span className="fw-drop-label">{t("fw.drag.mergeHint")}</span>
      </div>
    );
  }
  if (zone.type === "tabbar") {
    return <span className="fw-tabbar-hint" aria-hidden="true" />;
  }
  return null;
}

export default function FilePane({
  paneId,
  pageActive,
  onHoverZone,
  dropHint,
  layoutEditMode,
  projectRoot,
}: Props) {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);

  const pane = useFilesWorkspaceStore((s) => s.panes[paneId]);
  const isActivePane = useFilesWorkspaceStore((s) => s.activePaneId === paneId);
  const selection = useFilesWorkspaceStore((s) => s.selection[paneId]);
  const recentDirs = useFilesWorkspaceStore((s) => s.recentDirs);
  const pinnedDirs = useFilesWorkspaceStore((s) => s.pinnedDirs);
  const maximized = useFilesWorkspaceStore((s) => s.maximizedPaneId === paneId);
  const paneCount = useFilesWorkspaceStore((s) => s.tree);
  const totalPanes = useMemo(() => {
    const count = (node: typeof paneCount): number =>
      node.type === "pane" ? 1 : count(node.first) + count(node.second);
    return count(paneCount);
  }, [paneCount]);

  const store = useFilesWorkspaceStore;

  const [dirState, setDirState] = useState<DirState | null>(null);
  const [pathEdit, setPathEdit] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null);
  const [dialog, setDialog] = useState<PendingOp | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [dialogInput, setDialogInput] = useState("");
  const [propsData, setPropsData] = useState<FsStat | null>(null);
  const [deletePermanent, setDeletePermanent] = useState(false);
  /** 关闭区域被容量阻止：列出待安置标签，让用户明确选择而不是静默丢弃。 */
  const [closePrompt, setClosePrompt] = useState<{
    tabs: FolderTab[];
    unplaced: FolderTab[];
    targetPaneId?: string;
    capacity: number;
  } | null>(null);

  const tabbarRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const dragCandidate = useRef<{ x: number; y: number; entry: FsEntry | null; tabId: string | null; paneDrag: boolean } | null>(null);
  /** Ctrl 点击已选项的取消选择延迟到 pointerup；若随后形成拖拽则保留整组选择。 */
  const pendingCtrlToggle = useRef<string | null>(null);
  const lastZoneRef = useRef<FwDropZone | null>(null);

  const tab: FolderTab | null = pane?.tabs.find((x) => x.tabId === pane.activeTabId) ?? null;
  const dirPath = tab?.path ?? "";
  const showHidden = tab?.showHidden ?? false;

  // ── 目录列表：加载 / 订阅 / 轮询 ─────────────────────────────────────
  useEffect(() => {
    if (!dirPath) {
      setDirState(null);
      return;
    }
    loadDir(dirPath, showHidden);
    const unsub = subscribeDir(dirPath, showHidden, (state) => setDirState({ ...state }));
    setDirState({ ...getDirState(dirPath, showHidden) });
    return unsub;
  }, [dirPath, showHidden]);

  useEffect(() => {
    if (!pageActive || !dirPath) return;
    const timer = window.setInterval(() => {
      // 页面不可见（窗口最小化/隐藏/切到其他应用）时不轮询：WebView 的定时器
      // 不会因为不可见而停，多分栏叠加就是纯浪费的 IPC 与磁盘 metadata 探测。
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      reloadIfChanged(dirPath, showHidden);
    }, POLL_INTERVAL_MS);
    // 重新可见时立即补一次，避免等了半轮才更新。
    const onVisibility = () => {
      if (document.visibilityState === "visible") reloadIfChanged(dirPath, showHidden);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pageActive, dirPath, showHidden]);

  // 目录切换时清空选择（区域内状态独立）。
  useEffect(() => {
    store.getState().clearSelection(paneId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirPath]);

  // F2 重命名（面板键盘层派发事件到本窗格）：打开统一重命名对话框。
  useEffect(() => {
    const onRename = (e: Event) => {
      const detail = (e as CustomEvent<{ paneId: string; path: string }>).detail;
      if (detail.paneId !== paneId) return;
      setDialog({ kind: "rename", path: detail.path });
      setDialogInput(detail.path.split(/[\\/]/).filter(Boolean).pop() ?? "");
    };
    const onNewFolder = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== paneId) return;
      setDialog({ kind: "newDir" });
      setDialogInput(t("fw.menu.newFolderName"));
    };
    const onFocusPath = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== paneId) return;
      setPathEdit(dirPath);
    };
    window.addEventListener("taskdock-fw-rename", onRename);
    window.addEventListener("taskdock-fw-new-folder", onNewFolder);
    window.addEventListener("taskdock-fw-focus-path", onFocusPath);
    return () => {
      window.removeEventListener("taskdock-fw-rename", onRename);
      window.removeEventListener("taskdock-fw-new-folder", onNewFolder);
      window.removeEventListener("taskdock-fw-focus-path", onFocusPath);
    };
  }, [paneId, dirPath, t]);

  // ── 排序 / 筛选（内存完成，目录恒在前）──────────────────────────────
  const visibleEntries = useMemo(() => {
    if (!dirState?.listing) return [];
    const entries = dirState.listing;
    const search = tab?.search.trim().toLowerCase();
    const filter = tab?.filter ?? "all";
    const now = Date.now();
    const filtered = entries.filter((entry) => {
      const bySearch = !search || entry.name.toLowerCase().includes(search);
      if (!bySearch) return false;
      if (filter === "all") return true;
      if (filter === "large") return entry.kind === "file" && (entry.size ?? 0) >= 50 * 1024 * 1024;
      if (filter === "recent") return (entry.modifiedMs ?? 0) >= now - 7 * 24 * 60 * 60 * 1000;
      return entry.category === filter;
    });
    const field = tab?.sortField ?? "name";
    const asc = tab?.sortAsc ?? true;
    return [...filtered].sort((a, b) => {
      const aDir = a.kind === "dir";
      const bDir = b.kind === "dir";
      if (aDir !== bDir) return aDir ? -1 : 1;
      let cmp = 0;
      if (field === "name") cmp = a.name.localeCompare(b.name, "zh-CN", { numeric: true });
      else if (field === "modified") cmp = (a.modifiedMs ?? 0) - (b.modifiedMs ?? 0);
      else if (field === "size") cmp = (a.size ?? 0) - (b.size ?? 0);
      else cmp = (a.ext || "~").localeCompare(b.ext || "~") || a.name.localeCompare(b.name, "zh-CN");
      return asc ? cmp : -cmp;
    });
  }, [dirState?.listing, tab?.search, tab?.filter, tab?.sortField, tab?.sortAsc]);

  const selectedSet = useMemo(() => new Set(selection?.paths ?? []), [selection?.paths]);
  const selectedPaths = useMemo(
    () => (selection?.paths ?? []).filter((p) => p.startsWith(dirPath)),
    [selection?.paths, dirPath],
  );

  // ── 拖拽悬停解析（应用内拖拽，仅本窗格命中时上报）────────────────────
  const computeZone = useCallback(
    (x: number, y: number, payloadKind: "tabs" | "files" | "pane"): FwDropZone | null => {
      const el = paneRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;

      // 布局编辑模式：落点只有「区域中心 = 交换位置」，不参与文件/标签命中。
      if (payloadKind === "pane") return { type: "pane-swap", paneId };

      const bar = tabbarRef.current;
      const barRect = bar?.getBoundingClientRect();
      // 标签栏优先：拖到标签栏表示「并入这个区域的标签栏 / 调整标签顺序」，
      // 不应被上边缘分栏抢走（旧实现顶边 26px 覆盖了整条标签栏，语义冲突）。
      if (payloadKind === "tabs" && bar && barRect && y >= barRect.top && y <= barRect.bottom) {
        const tabs = bar.querySelectorAll<HTMLElement>("[data-fw-tab]");
        let index = tabs.length;
        for (let i = 0; i < tabs.length; i += 1) {
          const r = tabs[i].getBoundingClientRect();
          if (x < r.left + r.width / 2) {
            index = i;
            break;
          }
        }
        return { type: "tabbar", paneId, index };
      }

      if (payloadKind === "tabs") {
        // 命中带按比例放大（22%，上限 160px；窄窗格仍有 40px 兜底），中心区保留稳定区域；
        // 旧实现固定 26px，窄窗格里几乎不可能命中，用户只能靠把手拖拽。
        const bandX = Math.min(Math.max(40, rect.width * 0.22), 160);
        const bandY = Math.min(Math.max(32, rect.height * 0.22), 160);
        const left = x - rect.left;
        const right = rect.right - x;
        const top = y - rect.top;
        const bottom = rect.bottom - y;
        const horizontal = Math.min(left, right);
        const vertical = Math.min(top, bottom);
        // 先判断更近的水平边，再判断垂直边：取距离最近的一侧，避免四角同时命中时抖动。
        if (horizontal <= bandX && horizontal <= vertical) {
          return { type: "edge", paneId, edge: left <= right ? "left" : "right" };
        }
        if (vertical <= bandY) {
          return { type: "edge", paneId, edge: top <= bottom ? "top" : "bottom" };
        }
        return { type: "center", paneId, dir: dirPath };
      }
      // 文件拖拽：目录行优先，其次窗格中心（当前目录）。
      if (!dirPath) return null;
      const dragPaths = (): string[] => {
        const p = getFwDragState().payload;
        return p && p.kind === "files" ? p.paths : [];
      };
      const under = document.elementFromPoint(x, y);
      const row = under?.closest<HTMLElement>("[data-fw-path]");
      if (row?.dataset.fwKind === "dir") {
        const target = row.dataset.fwPath ?? "";
        return validateFileDrop(dragPaths(), target)
          ? { type: "folder", paneId, path: target }
          : null;
      }
      return validateFileDrop(dragPaths(), dirPath)
        ? { type: "center", paneId, dir: dirPath }
        : null;
    },
    [paneId, dirPath],
  );

  useEffect(() => {
    return subscribeFwDrag((fw) => {
      if (!fw.payload) {
        if (lastZoneRef.current) {
          lastZoneRef.current = null;
          onHoverZone(null);
        }
        return;
      }
      // 命中按协调器最新坐标计算；仅变化时上报，杜绝每次移动整树重渲染。
      const zone = computeZone(fw.x, fw.y, fw.payload.kind);
      if (sameZone(zone, lastZoneRef.current)) return;
      lastZoneRef.current = zone;
      // 订阅回调内更新 hover 是允许的（签名不变时协调器不会再广播）——
      // 旧实现无条件 emit 造成订阅者→emit→订阅者的无限递归（P0 缺陷）。
      updateFwHover(zone);
      onHoverZone(zone);
    });
  }, [computeZone, onHoverZone]);

  // ── 拖拽起点（阈值触发）────────────────────────────────────────────
  const beginDragCandidate = (
    e: ReactPointerEvent,
    entry: FsEntry | null,
    tabId: string | null,
    paneDrag = false,
  ) => {
    if (e.button !== 0) return;
    pendingCtrlToggle.current = null;
    // 布局编辑模式只允许「拖动整个区域」，文件与标签拖拽全部暂停，避免争抢命中区域。
    if (layoutEditMode && !paneDrag) return;
    dragCandidate.current = { x: e.clientX, y: e.clientY, entry, tabId, paneDrag };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const cand = dragCandidate.current;
      if (!cand || isFwDragging()) return;
      if (Math.hypot(e.clientX - cand.x, e.clientY - cand.y) < DRAG_THRESHOLD_PX) return;
      dragCandidate.current = null;
      pendingCtrlToggle.current = null;
      if (cand.paneDrag) {
        startFwDrag({ kind: "pane", fromPaneId: paneId }, e.clientX, e.clientY, e);
      } else if (cand.tabId) {
        startFwDrag({ kind: "tabs", tabIds: [cand.tabId], fromPaneId: paneId, paths: [] }, e.clientX, e.clientY, e);
      } else if (cand.entry && !layoutEditMode) {
        const clicked = joinPath(dirPath, cand.entry.name);
        const paths = selectedSet.has(clicked) && selectedPaths.length > 0 ? [...selectedPaths] : [clicked];
        startFwDrag({ kind: "files", paths, fromPaneId: paneId }, e.clientX, e.clientY, e);
      }
    };
    const onUp = () => {
      const pending = pendingCtrlToggle.current;
      pendingCtrlToggle.current = null;
      dragCandidate.current = null;
      if (pending) {
        const current = store.getState().selection[paneId]?.paths ?? [];
        const next = current.filter((p) => p !== pending);
        store.getState().setSelection(paneId, next, next[0] ?? null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dirPath, layoutEditMode, paneId, selectedPaths, selectedSet, store]);

  // ── 选择 ────────────────────────────────────────────────────────────
  const onEntryPointerDown = (e: ReactPointerEvent, entry: FsEntry, _index: number) => {
    store.getState().setActivePane(paneId);
    beginDragCandidate(e, entry, null);
    const path = joinPath(dirPath, entry.name);
    // store 与渲染快照理论上同步；多选拖拽起始时以非空的一侧为准，
    // 避免极短窗口内 selection 被其它 pointer 事件短暂清空后把整组选择折叠成单项。
    const stored = store.getState().selection[paneId]?.paths ?? [];
    const current = stored.length > 0 ? stored : selectedPaths;
    if (e.ctrlKey || e.metaKey) {
      if (current.includes(path)) {
        // 已选项的 Ctrl 点击先不取消：若用户拖动则整组参与；真正点击（pointerup）时才移除。
        pendingCtrlToggle.current = path;
        return;
      }
      store.getState().setSelection(paneId, [...current, path], path);
    } else if (e.shiftKey && current.length > 0) {
      const anchor = selection?.anchor ?? current[0];
      const aIdx = visibleEntries.findIndex((x) => joinPath(dirPath, x.name) === anchor);
      const bIdx = visibleEntries.findIndex((x) => joinPath(dirPath, x.name) === path);
      if (aIdx >= 0 && bIdx >= 0) {
        const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
        const range = visibleEntries.slice(lo, hi + 1).map((x) => joinPath(dirPath, x.name));
        store.getState().setSelection(paneId, range, anchor);
        return;
      }
      store.getState().setSelection(paneId, [path], path);
    } else if (!current.includes(path)) {
      // 普通点击只在「点到未选项」时变成单选；按下已选中的任意一项必须保留整组选择，
      // 否则多选拖拽会在 pointerdown 时折叠成单文件（原生回归发现）。
      store.getState().setSelection(paneId, [path], path);
    }
  };

  const onBodyPointerDown = (e: ReactPointerEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest("[data-fw-path]")) {
      store.getState().setActivePane(paneId);
      store.getState().clearSelection(paneId);
    }
  };

  const onEntryActivate = (entry: FsEntry) => {
    const path = joinPath(dirPath, entry.name);
    if (entry.kind === "dir") {
      store.getState().openInPane(paneId, path, "replace");
      return;
    }
    void fsOpen(path).catch((e) => {
      showToast(t("fw.error.openFailed", { error: errorMessage(e) }), { kind: "error" });
    });
  };

  // ── 文件操作 ────────────────────────────────────────────────────────
  const refreshBoth = useCallback((targets: string[]) => {
    useFilesWorkspaceStore.getState().notifyDirsChanged(targets);
  }, []);

  const doCopyTo = useCallback(
    async (paths: string[], target: string): Promise<FsOpReport | null> => {
      // 与拖拽路径同一套语义：前端生成 operation_id，Rust 写权威业务结果。
      const op = startOperation("file", "workspace_copy", {
        component: "文件工作区",
        metadata: { count: paths.length },
      });
      try {
        op.stage("ipc");
        const report = await fsCopyPaths(paths, target, "rename", op.id);
        refreshBoth([target, ...paths.map((p) => parentOf(p) ?? "").filter(Boolean)]);
        showFsOpOutcome({ effect: "copy", report, t, showToast });
        return report;
      } catch (e) {
        // IPC 抛错已由 `invokeCommand` 记录并 `markLogged`：只有未被归属的错误
        // 才补一条终态，避免同一故障在诊断中心出现两条记录。
        if (!isLogged(e as object)) op.fail(e, { stage: "ipc" });
        showToast(errorMessage(e), { kind: "error" });
        return null;
      }
    },
    [refreshBoth, showToast, t],
  );

  const doMoveTo = useCallback(
    async (paths: string[], target: string): Promise<FsOpReport | null> => {
      const op = startOperation("file", "workspace_move", {
        component: "文件工作区",
        metadata: { count: paths.length },
      });
      try {
        op.stage("ipc");
        const report = await fsMovePaths(paths, target, "rename", op.id);
        refreshBoth([target, ...paths.map((p) => parentOf(p) ?? "").filter(Boolean)]);
        showFsOpOutcome({ effect: "move", report, t, showToast });
        return report;
      } catch (e) {
        if (!isLogged(e as object)) op.fail(e, { stage: "ipc" });
        showToast(errorMessage(e), { kind: "error" });
        return null;
      }
    },
    [refreshBoth, showToast, t],
  );

  const doDelete = useCallback(
    async (paths: string[], permanent: boolean) => {
      const op = startOperation("file", "workspace_delete", {
        component: "文件工作区",
        metadata: { count: paths.length },
      });
      try {
        op.stage("ipc");
        const report = await fsDeletePaths(paths, permanent, op.id);
        refreshBoth(paths.map((p) => parentOf(p) ?? "").filter(Boolean));
        showFsOpOutcome({
          effect: permanent ? "deletePermanent" : "deleteRecycle",
          report,
          t,
          showToast,
        });
        store.getState().clearSelection(paneId);
      } catch (e) {
        if (!isLogged(e as object)) op.fail(e, { stage: "ipc" });
        showToast(errorMessage(e), { kind: "error" });
      }
    },
    [paneId, refreshBoth, showToast, store, t],
  );

  const submitDialog = async () => {
    if (!dialog) return;
    const name = dialogInput.trim();
    if (!name) return;
    const kind = dialog.kind;
    const path = dialog.path;
    setDialog(null);
    if (kind === "newDir" && dirPath) {
      try {
        await fsCreateDir(dirPath, name);
        refreshBoth([dirPath]);
        showToast(t("fw.report.created", { name }), { kind: "success" });
      } catch (e) {
        showToast(errorMessage(e), { kind: "error" });
      }
    } else if (kind === "newFile" && dirPath) {
      try {
        await fsCreateFile(dirPath, name);
        refreshBoth([dirPath]);
        showToast(t("fw.report.created", { name }), { kind: "success" });
      } catch (e) {
        showToast(errorMessage(e), { kind: "error" });
      }
    } else if (kind === "rename" && path) {
      try {
        await fsRename(path, name);
        refreshBoth([parentOf(path) ?? ""].filter(Boolean));
        store.getState().clearSelection(paneId);
        showToast(t("fw.report.renamed", { name }), { kind: "success" });
      } catch (e) {
        showToast(errorMessage(e), { kind: "error" });
      }
    }
  };

  const openProps = async (path: string) => {
    try {
      const [stat] = await fsStat([path]);
      setPropsData(stat ?? null);
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  };

  const sendToShelf = async (paths: string[]) => {
    try {
      const result = await shelfAddPaths(paths, "reference", "manual", null);
      showToast(t("fw.report.toShelf", { count: result.added.length }), { kind: "success" });
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  };

  /** 选中上下文：跨窗格操作走面板统一目标选择器/冲突处理，不在窗格内另造 IPC。 */
  const requestCrossPane = (effect: "copy" | "move", paths = selectedPaths) => {
    if (!paths.length) return;
    window.dispatchEvent(
      new CustomEvent("taskdock-fw-request-transfer", {
        detail: { effect, paths: [...paths], sourcePaneId: paneId },
      }),
    );
  };

  const copySelectedPaths = async (paths = selectedPaths) => {
    if (!paths.length) return;
    const ok = await copyText(paths.join("\r\n"));
    showToast(ok ? t("fw.quick.pathsCopied", { count: paths.length }) : t("fw.quick.copyFailed"), {
      kind: ok ? "success" : "error",
    });
  };

  const revealSelected = async (paths = selectedPaths) => {
    if (!paths.length) return;
    try {
      await fsReveal(paths[0]);
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  };

  const previewSelected = (paths = selectedPaths) => {
    if (paths.length !== 1) return;
    window.dispatchEvent(
      new CustomEvent("taskdock-fw-preview", {
        detail: {
          paneId,
          path: paths[0],
          dir: dirPath,
          entries: visibleEntries.map((entry) => ({ ...entry })),
        },
      }),
    );
  };

  const batchRenameSelected = (paths = selectedPaths) => {
    if (paths.length < 2) return;
    window.dispatchEvent(
      new CustomEvent("taskdock-fw-batch-rename", { detail: { paneId, paths: [...paths] } }),
    );
  };

  const compareSelected = () => {
    window.dispatchEvent(
      new CustomEvent("taskdock-fw-compare", { detail: { paneId, paths: [...selectedPaths] } }),
    );
  };

  // ── 打开文件夹（原生选择器 / 路径 / 最近 / 固定 / 项目根）──────────────
  const reportPickFailure = (result: Extract<PickFolderResult, { status: "invalid" }>) => {
    if (result.reason === "notFound") {
      showToast(t("fw.pick.notFound", { path: result.path }), { kind: "error" });
    } else if (result.reason === "notDir") {
      showToast(t("fw.pick.notDir", { path: result.path }), { kind: "error" });
    } else {
      showToast(t("fw.pick.unreadable", { path: result.path, error: result.message ?? "" }), { kind: "error" });
    }
  };

  const openIntoPane = (path: string, mode: "newTab" | "replace" = "newTab") => {
    const ok = store.getState().openInPane(paneId, path, mode);
    if (!ok) {
      showToast(t("fw.pane.tabLimit", { max: MAX_TABS_PER_PANE }), { kind: "warning" });
    }
    return ok;
  };

  const browseAndOpen = async () => {
    const result = await pickFolder({
      title: t("fw.dialog.openFolder"),
      defaultPath: dirPath || projectRoot || undefined,
    });
    if (result.status === "cancelled") return; // 取消：不改标签、不改布局
    if (result.status === "invalid") {
      reportPickFailure(result);
      return;
    }
    openIntoPane(result.path, "newTab");
  };

  const requestClosePane = () => {
    const result = store.getState().closePane(paneId);
    if (result.status === "closed") return;
    if (result.reason === "capacity" || result.reason === "structure") {
      const s = store.getState();
      setClosePrompt({
        tabs: s.panes[paneId]?.tabs ?? [],
        unplaced: result.tabs,
        targetPaneId: result.targetPaneId,
        capacity: result.capacity,
      });
      return;
    }
    showToast(
      result.reason === "lastPane" ? t("fw.pane.closeLast") : t("fw.pane.closeFailed"),
      { kind: "warning" },
    );
  };

  const resolveClosePrompt = (mode: "stash" | "discard") => {
    const result = store.getState().closePane(paneId, { mode });
    setClosePrompt(null);
    if (result.status === "closed") {
      if (result.stashedTabs > 0) {
        showToast(t("fw.pane.closeStashed", { count: result.stashedTabs }), { kind: "info" });
      }
      return;
    }
    showToast(t("fw.pane.closeFailed"), { kind: "error" });
  };

  // ── 右键菜单 ────────────────────────────────────────────────────────
  const onEntryContextMenu = (e: ReactMouseEvent, entry: FsEntry) => {
    e.preventDefault();
    e.stopPropagation();
    const path = joinPath(dirPath, entry.name);
    const current = store.getState().selection[paneId]?.paths ?? [];
    if (!current.includes(path)) {
      store.getState().setSelection(paneId, [path], path);
    }
    store.getState().setActivePane(paneId);
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const onBodyContextMenu = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-fw-path]")) return;
    e.preventDefault();
    store.getState().setActivePane(paneId);
    setMenu({ x: e.clientX, y: e.clientY, entry: null });
  };

  const menuSelection = menu ? (store.getState().selection[paneId]?.paths ?? []) : [];
  const singlePath = menuSelection.length === 1 ? menuSelection[0] : null;

  const menuItems = useMemo(() => {
    if (menu?.entry) {
      const entry = menu.entry;
      const items: Array<{
        key: string;
        label: string;
        icon?: React.ReactNode;
        disabled?: boolean;
        danger?: boolean;
        onSelect?: () => void;
      }> = [];
      if (entry.kind === "dir") {
        items.push({
          key: "enter",
          label: t("fw.menu.enter"),
          icon: <ChevronRight size={13} />,
          onSelect: () => store.getState().openInPane(paneId, joinPath(dirPath, entry.name), "replace"),
        });
      } else {
        items.push({
          key: "open",
          label: t("fw.menu.open"),
          onSelect: () => void fsOpen(joinPath(dirPath, entry.name)).catch(() => {}),
        });
      }
      items.push({
        key: "reveal",
        label: t("fw.menu.reveal"),
        onSelect: () => void fsReveal(singlePath ?? joinPath(dirPath, entry.name)).catch(() => {}),
      });
      items.push({
        key: "preview",
        label: t("fw.menu.preview"),
        icon: <Eye size={13} />,
        disabled: menuSelection.length !== 1 || entry.kind === "dir",
        onSelect: () => previewSelected(menuSelection),
      });
      items.push({
        key: "copyTo",
        label: t("fw.menu.copyTo"),
        icon: <Copy size={13} />,
        disabled: totalPanes <= 1,
        onSelect: () => requestCrossPane("copy", menuSelection),
      });
      items.push({
        key: "moveTo",
        label: t("fw.menu.moveTo"),
        icon: <Move size={13} />,
        disabled: totalPanes <= 1,
        onSelect: () => requestCrossPane("move", menuSelection),
      });
      items.push({
        key: "copyPath",
        label: t("fw.menu.copyPath"),
        icon: <ClipboardCopy size={13} />,
        onSelect: () => void copySelectedPaths(menuSelection),
      });
      items.push({
        key: "batchRename",
        label: t("fw.menu.batchRename"),
        icon: <ListChecks size={13} />,
        disabled: menuSelection.length < 2,
        onSelect: () => batchRenameSelected(menuSelection),
      });
      items.push({
        key: "compare",
        label: t("fw.menu.compare"),
        icon: <GitCompare size={13} />,
        disabled: totalPanes <= 1,
        onSelect: compareSelected,
      });
      items.push({
        key: "copy",
        label: t("fw.menu.copy"),
        onSelect: () => {
          setFwClipboard({ mode: "copy", paths: menuSelection });
          showToast(t("fw.report.clipCopy", { count: menuSelection.length }), { kind: "info" });
        },
      });
      items.push({
        key: "cut",
        label: t("fw.menu.cut"),
        onSelect: () => {
          setFwClipboard({ mode: "cut", paths: menuSelection });
          showToast(t("fw.report.clipCut", { count: menuSelection.length }), { kind: "info" });
        },
      });
      items.push({
        key: "shelf",
        label: t("fw.menu.toShelf"),
        onSelect: () => void sendToShelf(menuSelection),
      });
      items.push({
        key: "rename",
        label: t("fw.menu.rename"),
        disabled: menuSelection.length !== 1,
        onSelect: () => {
          setDialog({ kind: "rename", path: singlePath ?? undefined });
          setDialogInput(entry.name);
        },
      });
      items.push({
        key: "delete",
        label: t("fw.menu.delete"),
        danger: true,
        onSelect: () => {
          setDeletePermanent(false);
          setDialog({ kind: "delete" });
        },
      });
      items.push({
        key: "deletePermanent",
        label: t("fw.menu.deletePermanent"),
        danger: true,
        onSelect: () => {
          // 永久删除独立入口 + 独立确认文案（不与回收站语义混用）。
          setDeletePermanent(true);
          setDialog({ kind: "delete" });
        },
      });
      items.push({
        key: "props",
        label: t("fw.menu.props"),
        onSelect: () => void openProps(singlePath ?? joinPath(dirPath, entry.name)),
      });
      return items;
    }
    // 空白处菜单：新建 / 粘贴 / 刷新 / 隐藏文件
    return [
      {
        key: "newDir",
        label: t("fw.menu.newFolder"),
        onSelect: () => {
          setDialog({ kind: "newDir" });
          setDialogInput(t("fw.menu.newFolderName"));
        },
      },
      {
        key: "newFile",
        label: t("fw.menu.newFile"),
        onSelect: () => {
          setDialog({ kind: "newFile" });
          setDialogInput(t("fw.menu.newFileName"));
        },
      },
      {
        key: "paste",
        label: t("fw.menu.paste"),
        disabled: !getFwClipboard() || !dirPath,
        onSelect: () => {
          const clip = getFwClipboard();
          if (clip && dirPath) {
            // 剪切语义（P0）：部分失败只保留未完成项，失败不静默清空。
            void (clip.mode === "copy" ? doCopyTo(clip.paths, dirPath) : doMoveTo(clip.paths, dirPath)).then((report) => {
              if (clip.mode === "cut") {
                // 失败与「部分完成」都视为源仍在：保留在剪切待办。
                const pending = report
                  ? report.entries
                      .filter((r) => r.status === "failed" || r.status === "partial")
                      .map((r) => r.source)
                  : [...clip.paths];
                setFwClipboard(pending.length ? { mode: "cut", paths: pending } : null);
              }
            });
          }
        },
      },
      { key: "refresh", label: t("fw.menu.refresh"), onSelect: () => refreshBoth([dirPath]) },
      {
        key: "hidden",
        label: tab?.showHidden ? t("fw.menu.hideHidden") : t("fw.menu.showHidden"),
        onSelect: () => {
          if (tab) store.getState().patchTab(paneId, tab.tabId, { showHidden: !tab.showHidden });
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, dirPath, paneId, menuSelection, singlePath, tab, t]);

  // ── 面包屑 ──────────────────────────────────────────────────────────
  const crumbs = useMemo(() => breadcrumbSegments(dirPath), [dirPath]);
  const canBack = tab ? tab.historyIndex > 0 : false;
  const canForward = tab ? tab.historyIndex < tab.history.length - 1 : false;
  const canUp = Boolean(parentOf(dirPath));

  // ── 空窗格（未打开目录）─────────────────────────────────────────────
  if (!tab || !dirPath) {
    const chip = (path: string) => (
      <button
        key={path}
        type="button"
        className="fw-empty-chip"
        onClick={() => openIntoPane(path, "newTab")}
        title={path}
      >
        <FolderOpen size={12} aria-hidden="true" />
        <span>{basename(path) || path}</span>
      </button>
    );
    const pinnedOnly = pinnedDirs.slice(0, 4);
    const recentOnly = recentDirs
      .filter((p) => !pinnedOnly.some((x) => x.toLowerCase() === p.toLowerCase()))
      .slice(0, 4);
    return (
      <section
        ref={paneRef}
        className={`fw-pane fw-pane-blank${isActivePane ? " is-active" : ""}${layoutEditMode ? " is-edit" : ""}`}
        data-fw-pane-id={paneId}
        aria-label={t("fw.pane.blankAria")}
      >
        {layoutEditMode && (
          <EditHandle paneId={paneId} onPointerDown={(e) => beginDragCandidate(e, null, null, true)} />
        )}
        <div className="fw-pane-tabbar" ref={tabbarRef} />
        <div className="fw-empty-pane">
          <span className="fw-empty-icon" aria-hidden="true">
            <FolderOpen size={26} strokeWidth={1.4} />
          </span>
          <h3 className="fw-empty-title">{t("fw.pane.noDir")}</h3>
          <p className="fw-empty-hint">{t("fw.pane.emptyHint")}</p>
          <div className="fw-empty-actions">
            <button type="button" className="btn sm primary" onClick={() => void browseAndOpen()}>
              <FolderOpen size={13} aria-hidden="true" />
              {t("fw.pane.browseFolder")}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => window.dispatchEvent(new CustomEvent("taskdock-fw-open-folder", { detail: paneId }))}
            >
              {t("fw.pane.inputPath")}
            </button>
          </div>
          {pinnedOnly.length > 0 && (
            <div className="fw-empty-group">
              <span className="fw-empty-label">{t("fw.pane.pinnedDirs")}</span>
              <div className="fw-empty-chips">{pinnedOnly.map(chip)}</div>
            </div>
          )}
          {recentOnly.length > 0 && (
            <div className="fw-empty-group">
              <span className="fw-empty-label">{t("fw.pane.recentDirs")}</span>
              <div className="fw-empty-chips">{recentOnly.map(chip)}</div>
            </div>
          )}
          {projectRoot && (
            <div className="fw-empty-group">
              <span className="fw-empty-label">{t("fw.pane.projectRoot")}</span>
              <div className="fw-empty-chips">{chip(projectRoot)}</div>
            </div>
          )}
          <p className="fw-empty-drop">{t("fw.pane.dropFolderHint")}</p>
        </div>
        <div className="fw-pane-status">
          <span className="fw-status-count">{t("fw.status.noDir")}</span>
        </div>
        {dropHint && <DropPreview zone={dropHint} />}
      </section>
    );
  }

  const dirError = dirState?.error === "DIR_MISSING" || (Boolean(dirState?.error) && !dirState?.listing);

  return (
    <section
      ref={paneRef}
      className={`fw-pane${isActivePane ? " is-active" : ""}${layoutEditMode ? " is-edit" : ""}`}
      data-fw-pane-id={paneId}
      data-fw-accept={dirPath}
      aria-label={t("fw.pane.aria", { path: dirPath })}
    >
      {/* 布局编辑模式：顶部简洁拖动把手（普通模式不出现，避免与文件/标签拖拽争抢） */}
      {layoutEditMode && (
        <EditHandle paneId={paneId} onPointerDown={(e) => beginDragCandidate(e, null, null, true)} />
      )}
      {/* 标签栏 */}
      <div className="fw-pane-tabbar" ref={tabbarRef} role="tablist" aria-label={t("fw.tabs.aria")}>
        {pane.tabs.map((item) => (
          <div
            key={item.tabId}
            role="tab"
            aria-selected={item.tabId === pane.activeTabId}
            data-fw-tab={item.tabId}
            className={`fw-tab${item.tabId === pane.activeTabId ? " is-active" : ""}`}
            onPointerDown={(e) => {
              store.getState().setActiveTab(paneId, item.tabId);
              beginDragCandidate(e, null, item.tabId);
            }}
            onDoubleClick={() => store.getState().duplicateTab(paneId, item.tabId)}
            onAuxClick={(e) => {
              if (e.button === 1) store.getState().closeTab(paneId, item.tabId);
            }}
          >
            <span className="fw-tab-label" title={item.path}>
              {tabTitle(item)}
            </span>
            <button
              type="button"
              className="fw-tab-close"
              aria-label={t("fw.tab.close", { name: tabTitle(item) })}
              onClick={(e) => {
                e.stopPropagation();
                store.getState().closeTab(paneId, item.tabId);
              }}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="fw-tab-add"
          aria-label={t("fw.tab.new")}
          data-tip={t("fw.tab.new")}
          onClick={() => window.dispatchEvent(new CustomEvent("taskdock-fw-open-folder", { detail: paneId }))}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>

      {/* 导航工具栏 */}
      <div className="fw-pane-toolbar">
        <div className="fw-navbtns">
          <button type="button" className="fw-icon-btn" aria-label={t("fw.pane.back")} disabled={!canBack} onClick={() => store.getState().navigate(paneId, "back")}>
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
          <button type="button" className="fw-icon-btn" aria-label={t("fw.pane.forward")} disabled={!canForward} onClick={() => store.getState().navigate(paneId, "forward")}>
            <ArrowRight size={14} aria-hidden="true" />
          </button>
          <button type="button" className="fw-icon-btn" aria-label={t("fw.pane.up")} disabled={!canUp} onClick={() => store.getState().navigate(paneId, "up")}>
            <ArrowUp size={14} aria-hidden="true" />
          </button>
          <button type="button" className="fw-icon-btn" aria-label={t("fw.pane.refresh")} onClick={() => refreshBoth([dirPath])}>
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        </div>

        <div className="fw-crumbs" role="navigation" aria-label={t("fw.pane.crumbsAria")}>
          {pathEdit !== null ? (
            <input
              className="fw-path-input"
              value={pathEdit}
              autoFocus
              aria-label={t("fw.pane.pathAria")}
              onChange={(e) => setPathEdit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const next = normalizePath(pathEdit);
                  setPathEdit(null);
                  if (next) store.getState().openInPane(paneId, next, "replace");
                } else if (e.key === "Escape") {
                  setPathEdit(null);
                }
              }}
              onBlur={() => setPathEdit(null)}
            />
          ) : (
            <div
              className="fw-crumbs-inner"
              role="presentation"
              onClick={() => setPathEdit(dirPath)}
              title={dirPath}
            >
              {crumbs.length <= 3 ? (
                crumbs.map((seg, i) => (
                  <span key={seg.path} className="fw-crumb-wrap">
                    {i > 0 && <ChevronRight size={11} aria-hidden="true" className="fw-crumb-sep" />}
                    <button
                      type="button"
                      className="fw-crumb"
                      onClick={(e) => {
                        e.stopPropagation();
                        store.getState().openInPane(paneId, seg.path, "replace");
                      }}
                    >
                      {seg.name}
                    </button>
                  </span>
                ))
              ) : (
                <>
                  <button
                    type="button"
                    className="fw-crumb"
                    onClick={(e) => {
                      e.stopPropagation();
                      store.getState().openInPane(paneId, crumbs[0].path, "replace");
                    }}
                  >
                    {crumbs[0].name}
                  </button>
                  <ChevronRight size={11} aria-hidden="true" className="fw-crumb-sep" />
                  <span className="fw-crumb-ellipsis">…</span>
                  {crumbs.slice(-2).map((seg) => (
                    <span key={seg.path} className="fw-crumb-wrap">
                      <ChevronRight size={11} aria-hidden="true" className="fw-crumb-sep" />
                      <button
                        type="button"
                        className="fw-crumb"
                        onClick={(e) => {
                          e.stopPropagation();
                          store.getState().openInPane(paneId, seg.path, "replace");
                        }}
                      >
                        {seg.name}
                      </button>
                    </span>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          className={`fw-icon-btn${(tab.filter ?? "all") !== "all" ? " is-on" : ""}`}
          aria-label={t("fw.filter.toggle")}
          aria-expanded={filterOpen}
          data-tip={t("fw.filter.toggle")}
          onClick={() => setFilterOpen((value) => !value)}
        >
          <Filter size={13} aria-hidden="true" />
        </button>

        <div className="fw-searchbox">
          <Search size={12} aria-hidden="true" />
          <input
            value={tab.search}
            placeholder={t("fw.pane.searchTip")}
            aria-label={t("fw.pane.searchAria")}
            onChange={(e) => store.getState().patchTab(paneId, tab.tabId, { search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && tab.search) {
                e.stopPropagation();
                store.getState().patchTab(paneId, tab.tabId, { search: "" });
              }
            }}
          />
          {tab.search && (
            <button
              type="button"
              className="fw-icon-btn"
              aria-label={t("common.clear")}
              onClick={() => store.getState().patchTab(paneId, tab.tabId, { search: "" })}
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="fw-navbtns">
          <button
            type="button"
            className={`fw-icon-btn${tab.viewMode === "grid" ? " is-on" : ""}`}
            aria-label={tab.viewMode === "list" ? t("fw.pane.gridView") : t("fw.pane.listView")}
            data-tip={tab.viewMode === "list" ? t("fw.pane.gridView") : t("fw.pane.listView")}
            onClick={() => store.getState().patchTab(paneId, tab.tabId, { viewMode: tab.viewMode === "list" ? "grid" : "list" })}
          >
            {tab.viewMode === "list" ? <LayoutGrid size={14} aria-hidden="true" /> : <ListIcon size={14} aria-hidden="true" />}
          </button>
          <DropdownMenu
            menuLabel={t("fw.sort.menu")}
            placement="bottom-end"
            trigger={({ ref, expanded, onClick, onKeyDown }) => (
              <button
                ref={ref}
                type="button"
                className="fw-icon-btn"
                aria-haspopup="menu"
                aria-expanded={expanded}
                aria-label={t("fw.sort.menu")}
                onClick={onClick}
                onKeyDown={onKeyDown}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            )}
            items={[
              { key: "name", label: t("fw.sort.name"), radio: true, checked: tab.sortField === "name", onSelect: () => store.getState().patchTab(paneId, tab.tabId, { sortField: "name" }) },
              { key: "modified", label: t("fw.sort.modified"), radio: true, checked: tab.sortField === "modified", onSelect: () => store.getState().patchTab(paneId, tab.tabId, { sortField: "modified" }) },
              { key: "type", label: t("fw.sort.type"), radio: true, checked: tab.sortField === "type", onSelect: () => store.getState().patchTab(paneId, tab.tabId, { sortField: "type" }) },
              { key: "size", label: t("fw.sort.size"), radio: true, checked: tab.sortField === "size", onSelect: () => store.getState().patchTab(paneId, tab.tabId, { sortField: "size" }) },
              { key: "asc", label: t("fw.sort.asc"), radio: true, checked: tab.sortAsc, onSelect: () => store.getState().patchTab(paneId, tab.tabId, { sortAsc: true }) },
              { key: "desc", label: t("fw.sort.desc"), radio: true, checked: !tab.sortAsc, onSelect: () => store.getState().patchTab(paneId, tab.tabId, { sortAsc: false }) },
            ]}
          />
          <button
            type="button"
            className={`fw-icon-btn${tab.showHidden ? " is-on" : ""}`}
            aria-label={t("fw.pane.hiddenToggle")}
            aria-pressed={tab.showHidden}
            data-tip={t("fw.pane.hiddenToggle")}
            onClick={() => store.getState().patchTab(paneId, tab.tabId, { showHidden: !tab.showHidden })}
          >
            {tab.showHidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
          </button>
          <DropdownMenu
            menuLabel={t("fw.pane.more")}
            placement="bottom-end"
            trigger={({ ref, expanded, onClick, onKeyDown }) => (
              <button
                ref={ref}
                type="button"
                className="fw-icon-btn"
                aria-haspopup="menu"
                aria-expanded={expanded}
                aria-label={t("fw.pane.more")}
                onClick={onClick}
                onKeyDown={onKeyDown}
              >
                <MoreHorizontal size={14} aria-hidden="true" />
              </button>
            )}
            items={[
              {
                key: "browseFolder",
                label: t("fw.pane.browseFolder"),
                icon: <FolderOpen size={13} />,
                onSelect: () => void browseAndOpen(),
              },
              {
                key: "openFolder",
                label: t("fw.pane.openFolderMore"),
                icon: <FolderPlus size={13} />,
                onSelect: () =>
                  window.dispatchEvent(new CustomEvent("taskdock-fw-open-folder", { detail: paneId })),
              },
              { key: "newDir", label: t("fw.menu.newFolder"), onSelect: () => { setDialog({ kind: "newDir" }); setDialogInput(t("fw.menu.newFolderName")); } },
              { key: "newFile", label: t("fw.menu.newFile"), onSelect: () => { setDialog({ kind: "newFile" }); setDialogInput(t("fw.menu.newFileName")); } },
              { key: "sep1", separator: true },
              { key: "dupTab", label: t("fw.tab.duplicate"), onSelect: () => store.getState().duplicateTab(paneId, tab.tabId) },
              { key: "closeTab", label: t("fw.tab.closeCurrent"), onSelect: () => store.getState().closeTab(paneId, tab.tabId) },
              { key: "sep2", separator: true },
              { key: "splitLeft", label: t("fw.pane.splitLeft"), onSelect: () => store.getState().splitPane(paneId, "horizontal", null, "before") },
              { key: "splitH", label: t("fw.pane.splitRight"), onSelect: () => store.getState().splitPane(paneId, "horizontal") },
              { key: "splitUp", label: t("fw.pane.splitUp"), onSelect: () => store.getState().splitPane(paneId, "vertical", null, "before") },
              { key: "splitV", label: t("fw.pane.splitDown"), onSelect: () => store.getState().splitPane(paneId, "vertical") },
              { key: "swap", label: t("fw.pane.swap"), onSelect: () => store.getState().swapPane(paneId) },
              { key: "maximize", label: maximized ? t("fw.layout.restoreMax") : t("fw.layout.maximize"), onSelect: () => store.getState().toggleMaximize(paneId), disabled: totalPanes <= 1 },
              { key: "sep3", separator: true },
              { key: "closePane", label: t("fw.pane.closeRegion"), disabled: totalPanes <= 1, onSelect: requestClosePane },
            ]}
          />
        </div>
      </div>

      {filterOpen && (
        <div className="fw-filter-bar" role="toolbar" aria-label={t("fw.filter.aria")}>
          {(["all", "folder", "image", "video", "audio", "doc", "sheet", "slide", "code", "archive", "large", "recent"] as FileFilter[]).map(
            (filter) => (
              <button
                key={filter}
                type="button"
                className={`fw-filter-chip${(tab.filter ?? "all") === filter ? " is-active" : ""}`}
                onClick={() => store.getState().patchTab(paneId, tab.tabId, { filter })}
              >
                {t(`fw.filter.${filter}`)}
              </button>
            ),
          )}
        </div>
      )}

      {/* 选中上下文操作区：高频操作按选择出现，常驻工具栏保持收敛 */}
      {selectedPaths.length > 0 && (
        <div className="fw-selection-bar" role="toolbar" aria-label={t("fw.selection.aria")}>
          <span className="fw-selection-count">{t("fw.status.selected", { count: selectedPaths.length })}</span>
          {totalPanes > 1 && (
            <>
              <button
                type="button"
                className="fw-selection-btn"
                onClick={() => requestCrossPane("copy")}
                data-tip={t("fw.action.copyTo")}
              >
                <Copy size={13} aria-hidden="true" />
                <span>{t("fw.action.copyTo")}</span>
              </button>
              <button
                type="button"
                className="fw-selection-btn"
                onClick={() => requestCrossPane("move")}
                data-tip={t("fw.action.moveTo")}
              >
                <Move size={13} aria-hidden="true" />
                <span>{t("fw.action.moveTo")}</span>
              </button>
            </>
          )}
          <button
            type="button"
            className="fw-selection-btn"
            onClick={() => void sendToShelf(selectedPaths)}
            data-tip={t("fw.action.toShelf")}
          >
            <Send size={13} aria-hidden="true" />
            <span>{t("fw.action.toShelf")}</span>
          </button>
          <button
            type="button"
            className="fw-selection-btn"
            onClick={() => void copySelectedPaths()}
            data-tip={t("fw.action.copyPath")}
          >
            <ClipboardCopy size={13} aria-hidden="true" />
            <span>{t("fw.action.copyPath")}</span>
          </button>
          <button
            type="button"
            className="fw-selection-btn"
            onClick={() => void revealSelected()}
            data-tip={t("fw.action.reveal")}
          >
            <ExternalLink size={13} aria-hidden="true" />
            <span>{t("fw.action.reveal")}</span>
          </button>
          {selectedPaths.length === 1 && (
            <button
              type="button"
              className="fw-selection-btn"
              onClick={() => previewSelected()}
              data-tip={t("fw.action.preview")}
            >
              <Eye size={13} aria-hidden="true" />
              <span>{t("fw.action.preview")}</span>
            </button>
          )}
          {selectedPaths.length > 1 && (
            <button
              type="button"
              className="fw-selection-btn"
              onClick={() => batchRenameSelected()}
              data-tip={t("fw.action.batchRename")}
            >
              <ListChecks size={13} aria-hidden="true" />
              <span>{t("fw.action.batchRename")}</span>
            </button>
          )}
          {totalPanes > 1 && (
            <button
              type="button"
              className="fw-selection-btn"
              onClick={compareSelected}
              data-tip={t("fw.action.compare")}
            >
              <GitCompare size={13} aria-hidden="true" />
              <span>{t("fw.action.compare")}</span>
            </button>
          )}
        </div>
      )}

      {/* 内容区 */}
      {dirError ? (
        <div className="fw-body-error" role="alert">
          <p>{t("fw.pane.dirMissing")}</p>
          <code className="fw-error-path">{dirPath}</code>
          <div className="fw-error-actions">
            <button type="button" className="btn sm" onClick={() => refreshBoth([dirPath])}>
              {t("common.retry")}
            </button>
            {parentOf(dirPath) && (
              <button
                type="button"
                className="btn sm"
                onClick={() => store.getState().openInPane(paneId, parentOf(dirPath)!, "replace")}
              >
                {t("fw.pane.goParent")}
              </button>
            )}
          </div>
        </div>
      ) : dirState?.loading && !dirState.listing ? (
        <div className="fw-body-loading" role="status" aria-label={t("nav.loading")} />
      ) : visibleEntries.length === 0 ? (
        <div className="fw-body-empty">
          <p>{tab.search ? t("fw.pane.noMatch") : t("fw.pane.emptyDir")}</p>
        </div>
      ) : (
        <FileList
          entries={visibleEntries}
          dirPath={dirPath}
          viewMode={tab.viewMode}
          selectedPaths={selectedSet}
          activePath={selectedPaths.length === 1 ? selectedPaths[0] : null}
          dropTargetPath={dropHint?.type === "folder" ? dropHint.path : null}
          thumbnails={tab.viewMode === "grid"}
          onEntryPointerDown={onEntryPointerDown}
          onEntryActivate={onEntryActivate}
          onEntryContextMenu={onEntryContextMenu}
          onBodyPointerDown={onBodyPointerDown}
          onBodyContextMenu={onBodyContextMenu}
        >
          {/* 超限目录翻页续拉（万级目录不再只能看前 8000 项）。 */}
          {dirState?.hasMore && (
            <button
              type="button"
              className="fw-load-more"
              disabled={dirState.loading}
              onClick={() => loadMore(dirPath, showHidden)}
            >
              {dirState.loading ? t("nav.loading") : t("fw.status.loadMore")}
            </button>
          )}
        </FileList>
      )}

      {/* 状态条 */}
      <div className="fw-pane-status">
        <span className="fw-status-count">
          {t("fw.status.items", { count: visibleEntries.length })}
          {selectedPaths.length > 0 ? ` · ${t("fw.status.selected", { count: selectedPaths.length })}` : ""}
        </span>
        {dirState?.hasMore && <span className="fw-status-truncated">{t("fw.status.truncated")}</span>}
      </div>

      {/* 应用内拖拽视觉提示层（细边框 + 半透明方向区 + 小标签） */}
      {dropHint && <DropPreview zone={dropHint} />}

      {/* 右键菜单（自由位置） */}
      {menu && (
        <FreeMenu
          x={menu.x}
          y={menu.y}
          menuLabel={menu.entry ? menu.entry.name : dirPath}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}

      {/* 新建 / 重命名对话框 */}
      <Dialog
        open={dialog?.kind === "newDir" || dialog?.kind === "newFile" || dialog?.kind === "rename"}
        onClose={() => setDialog(null)}
        title={
          dialog?.kind === "newDir"
            ? t("fw.menu.newFolder")
            : dialog?.kind === "newFile"
              ? t("fw.menu.newFile")
              : t("fw.menu.rename")
        }
        size="sm"
        ariaLabel={dialog?.kind === "rename" ? t("fw.menu.rename") : t("fw.dialog.createTitle")}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDialog(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary" disabled={!dialogInput.trim()} onClick={() => void submitDialog()}>
              {t("common.confirm")}
            </button>
          </>
        }
      >
        <label className="fw-dialog-field">
          <span>{dialog?.kind === "rename" ? t("fw.dialog.newName") : t("fw.dialog.name")}</span>
          <input
            className="ws-input"
            value={dialogInput}
            autoFocus
            onChange={(e) => setDialogInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitDialog();
            }}
          />
        </label>
      </Dialog>

      {/* 删除确认（回收站 / Shift 或菜单永久删除独立确认） */}
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        title={
          deletePermanent
            ? t("fw.dialog.deletePermanentTitle", { count: menuSelection.length })
            : t("fw.dialog.deleteTitle", { count: menuSelection.length })
        }
        detail={deletePermanent ? t("fw.dialog.deletePermanentBody") : t("fw.dialog.deleteBody")}
        confirmLabel={deletePermanent ? t("fw.dialog.deletePermanentConfirm") : t("fw.dialog.deleteConfirm")}
        danger
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          const paths = [...menuSelection];
          const permanent = deletePermanent;
          setDialog(null);
          setDeletePermanent(false);
          void doDelete(paths, permanent);
        }}
      />

      {/* 关闭区域：容量不足时列出会被收纳/关闭的标签，绝不静默丢弃 */}
      <Dialog
        open={closePrompt !== null}
        onClose={() => setClosePrompt(null)}
        title={t("fw.dialog.closePaneTitle")}
        size="sm"
        ariaLabel={t("fw.dialog.closePaneTitle")}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setClosePrompt(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn" onClick={() => resolveClosePrompt("stash")}>
              {t("fw.dialog.closePaneStash", { count: closePrompt?.unplaced.length ?? 0 })}
            </button>
            <button type="button" className="btn danger" onClick={() => resolveClosePrompt("discard")}>
              {t("fw.dialog.closePaneDiscard")}
            </button>
          </>
        }
      >
        {closePrompt && (
          <div className="fw-close-prompt">
            <p>
              {t("fw.dialog.closePaneBody", {
                count: closePrompt.tabs.length,
                max: closePrompt.capacity,
                unplaced: closePrompt.unplaced.length,
              })}
            </p>
            <ul className="fw-tab-list">
              {closePrompt.tabs.map((item) => (
                <li key={item.tabId} title={item.path}>
                  {tabTitle(item)}
                </li>
              ))}
            </ul>
            {closePrompt.unplaced.length > 0 && (
              <p className="fw-close-warn">
                {t("fw.dialog.closePaneUnplaced", { count: closePrompt.unplaced.length })}
              </p>
            )}
          </div>
        )}
      </Dialog>

      {/* 属性 */}
      <Dialog
        open={propsData !== null}
        onClose={() => setPropsData(null)}
        title={t("fw.props.title")}
        size="sm"
        ariaLabel={t("fw.props.title")}
        footer={
          <button type="button" className="btn" onClick={() => setPropsData(null)}>
            {t("common.close")}
          </button>
        }
      >
        {propsData && (
          <dl className="fw-props">
            <div>
              <dt>{t("fw.props.name")}</dt>
              <dd>{propsData.path.split(/[\\/]/).filter(Boolean).pop()}</dd>
            </div>
            <div>
              <dt>{t("fw.props.kind")}</dt>
              <dd>
                {propsData.kind === "dir"
                  ? CATEGORY_LABEL.folder
                  : propsData.kind === "link"
                    ? CATEGORY_LABEL.link
                    : CATEGORY_LABEL.other}
              </dd>
            </div>
            <div>
              <dt>{t("fw.props.size")}</dt>
              <dd>
                {propsData.kind === "dir"
                  ? t("fw.props.childCount", { count: propsData.childCount ?? 0 })
                  : formatSize(propsData.size)}
              </dd>
            </div>
            <div>
              <dt>{t("fw.props.modified")}</dt>
              <dd>{propsData.modifiedMs ? new Date(propsData.modifiedMs).toLocaleString() : "—"}</dd>
            </div>
            <div>
              <dt>{t("fw.props.created")}</dt>
              <dd>{propsData.createdMs ? new Date(propsData.createdMs).toLocaleString() : "—"}</dd>
            </div>
            <div>
              <dt>{t("fw.props.path")}</dt>
              <dd className="fw-props-path">{propsData.path}</dd>
            </div>
          </dl>
        )}
      </Dialog>
    </section>
  );
}

