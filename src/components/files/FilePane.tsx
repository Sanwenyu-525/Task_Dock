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
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArrowLeft,
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
} from "lucide-react";

import DropdownMenu from "../ui/DropdownMenu";
import { ConfirmDialog, Dialog } from "../ui/Dialog";
import FileList from "./FileList";
import { useLocale } from "../../hooks/useLocale";
import { errorMessage } from "../../lib/errors";
import {
  loadDir,
  reloadIfChanged,
  subscribeDir,
  getDirState,
  type DirState,
} from "../../lib/filesWorkspace/dirCache";
import { formatSize, CATEGORY_LABEL } from "../../lib/filesWorkspace/fileMeta";
import { breadcrumbSegments, joinPath, normalizePath, parentOf } from "../../lib/filesWorkspace/pathUtils";
import {
  isFwDragging,
  startFwDrag,
  subscribeFwDrag,
  updateFwHover,
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
  type FsStat,
} from "../../lib/bridge";
import { useFilesWorkspaceStore, tabTitle, type FolderTab } from "../../store/useFilesWorkspaceStore";
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

export default function FilePane({ paneId, pageActive, onHoverZone, dropHint }: Props) {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);

  const pane = useFilesWorkspaceStore((s) => s.panes[paneId]);
  const isActivePane = useFilesWorkspaceStore((s) => s.activePaneId === paneId);
  const selection = useFilesWorkspaceStore((s) => s.selection[paneId]);
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
  const [dialogInput, setDialogInput] = useState("");
  const [propsData, setPropsData] = useState<FsStat | null>(null);

  const tabbarRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const dragCandidate = useRef<{ x: number; y: number; entry: FsEntry | null; tabId: string | null; paneMove: boolean } | null>(null);
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
      reloadIfChanged(dirPath, showHidden);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pageActive, dirPath, showHidden]);

  // 目录切换时清空选择（区域内状态独立）。
  useEffect(() => {
    store.getState().clearSelection(paneId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirPath]);

  // ── 排序 / 筛选（内存完成，目录恒在前）──────────────────────────────
  const visibleEntries = useMemo(() => {
    if (!dirState?.listing) return [];
    const entries = dirState.listing;
    const search = tab?.search.trim().toLowerCase();
    const filtered = search ? entries.filter((e) => e.name.toLowerCase().includes(search)) : entries;
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
  }, [dirState?.listing, tab?.search, tab?.sortField, tab?.sortAsc]);

  const selectedSet = useMemo(() => new Set(selection?.paths ?? []), [selection?.paths]);
  const selectedPaths = useMemo(
    () => (selection?.paths ?? []).filter((p) => p.startsWith(dirPath)),
    [selection?.paths, dirPath],
  );

  // ── 拖拽悬停解析（应用内拖拽，仅本窗格命中时上报）────────────────────
  const computeZone = useCallback(
    (x: number, y: number, payloadKind: "tabs" | "files"): FwDropZone | null => {
      const el = paneRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
      const EDGE = 26;
      if (payloadKind === "tabs") {
        const inLeft = x - rect.left <= EDGE;
        const inRight = rect.right - x <= EDGE;
        const inTop = y - rect.top <= EDGE;
        const inBottom = rect.bottom - y <= EDGE;
        if (inLeft) return { type: "edge", paneId, edge: "left" };
        if (inRight) return { type: "edge", paneId, edge: "right" };
        if (inTop) return { type: "edge", paneId, edge: "top" };
        if (inBottom) return { type: "edge", paneId, edge: "bottom" };
        const bar = tabbarRef.current;
        if (bar) {
          const barRect = bar.getBoundingClientRect();
          if (y >= barRect.top && y <= barRect.bottom) {
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
        }
        return { type: "center", paneId };
      }
      // 文件拖拽：目录行优先，其次窗格中心（当前目录）。
      if (!dirPath) return null;
      const under = document.elementFromPoint(x, y);
      const row = under?.closest<HTMLElement>("[data-fw-path]");
      if (row?.dataset.fwKind === "dir") {
        const target = row.dataset.fwPath ?? "";
        return validateFileDrop(getFwDragState().payload?.paths ?? [], target)
          ? { type: "folder", paneId, path: target }
          : null;
      }
      return validateFileDrop(getFwDragState().payload?.paths ?? [], dirPath)
        ? { type: "center", paneId }
        : null;
    },
    [paneId, dirPath],
  );

  useEffect(() => {
    return subscribeFwDrag((state) => {
      if (!state.payload) {
        if (lastZoneRef.current) {
          lastZoneRef.current = null;
          onHoverZone(null);
        }
        return;
      }
      const zone = computeZone(state.x, state.y, state.payload.kind);
      if (zone) {
        lastZoneRef.current = zone;
        updateFwHover(zone, {});
        onHoverZone(zone);
      } else if (lastZoneRef.current) {
        lastZoneRef.current = null;
        onHoverZone(null);
      }
    });
  }, [computeZone, onHoverZone]);

  // ── 拖拽起点（阈值触发）────────────────────────────────────────────
  const beginDragCandidate = (e: ReactPointerEvent, entry: FsEntry | null, tabId: string | null, paneMove = false) => {
    if (e.button !== 0) return;
    dragCandidate.current = { x: e.clientX, y: e.clientY, entry, tabId, paneMove };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const cand = dragCandidate.current;
      if (!cand || isFwDragging()) return;
      if (Math.hypot(e.clientX - cand.x, e.clientY - cand.y) < DRAG_THRESHOLD_PX) return;
      dragCandidate.current = null;
      if (cand.paneMove) {
        const st = store.getState();
        const allTabs = st.panes[paneId]?.tabs.map((x) => x.tabId) ?? [];
        startFwDrag({ kind: "tabs", tabIds: allTabs, fromPaneId: paneId, paths: [], paneMove: true }, e.clientX, e.clientY);
      } else if (cand.tabId) {
        startFwDrag({ kind: "tabs", tabIds: [cand.tabId], fromPaneId: paneId, paths: [] }, e.clientX, e.clientY);
      } else if (cand.entry) {
        const clicked = joinPath(dirPath, cand.entry.name);
        const paths = selectedSet.has(clicked) && selectedPaths.length > 0 ? [...selectedPaths] : [clicked];
        startFwDrag({ kind: "files", paths, fromPaneId: paneId }, e.clientX, e.clientY);
      }
    };
    const onUp = () => {
      dragCandidate.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dirPath, paneId, selectedPaths, selectedSet, store]);

  // ── 选择 ────────────────────────────────────────────────────────────
  const onEntryPointerDown = (e: ReactPointerEvent, entry: FsEntry, _index: number) => {
    store.getState().setActivePane(paneId);
    beginDragCandidate(e, entry, null);
    const path = joinPath(dirPath, entry.name);
    const current = store.getState().selection[paneId]?.paths ?? [];
    if (e.ctrlKey || e.metaKey) {
      const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
      store.getState().setSelection(paneId, next, path);
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
    } else if (!current.includes(path) || current.length !== 1) {
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
    async (paths: string[], target: string) => {
      try {
        const report = await fsCopyPaths(paths, target, "rename");
        refreshBoth([target, ...paths.map((p) => parentOf(p) ?? "").filter(Boolean)]);
        if (report.failed > 0) {
          showToast(t("fw.report.partial", { ok: report.ok, failed: report.failed }), { kind: "warning" });
        } else {
          showToast(t("fw.report.copyOk", { count: report.ok }), { kind: "success" });
        }
      } catch (e) {
        showToast(errorMessage(e), { kind: "error" });
      }
    },
    [refreshBoth, showToast, t],
  );

  const doMoveTo = useCallback(
    async (paths: string[], target: string) => {
      try {
        const report = await fsMovePaths(paths, target, "rename");
        refreshBoth([target, ...paths.map((p) => parentOf(p) ?? "").filter(Boolean)]);
        if (report.failed > 0) {
          showToast(t("fw.report.partial", { ok: report.ok, failed: report.failed }), { kind: "warning" });
        } else {
          showToast(t("fw.report.moveOk", { count: report.ok }), { kind: "success" });
        }
      } catch (e) {
        showToast(errorMessage(e), { kind: "error" });
      }
    },
    [refreshBoth, showToast, t],
  );

  const doDelete = useCallback(
    async (paths: string[], permanent: boolean) => {
      try {
        const report = await fsDeletePaths(paths, permanent);
        refreshBoth(paths.map((p) => parentOf(p) ?? "").filter(Boolean));
        if (report.failed > 0) {
          showToast(t("fw.report.partial", { ok: report.ok, failed: report.failed }), { kind: "warning" });
        } else {
          showToast(
            permanent
              ? t("fw.report.deletePermanent", { count: report.ok })
              : t("fw.report.deleteOk", { count: report.ok }),
            { kind: "success" },
          );
        }
        store.getState().clearSelection(paneId);
      } catch (e) {
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
        onSelect: () => setDialog({ kind: "delete" }),
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
            void (clip.mode === "copy" ? doCopyTo(clip.paths, dirPath) : doMoveTo(clip.paths, dirPath)).then(() => {
              if (clip.mode === "cut") setFwClipboard(null);
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
    return (
      <section
        ref={paneRef}
        className={`fw-pane fw-pane-blank${isActivePane ? " is-active" : ""}`}
        data-fw-pane-id={paneId}
        aria-label={t("fw.pane.blankAria")}
      >
        <div className="fw-pane-tabbar" ref={tabbarRef} />
        <div className="fw-empty-pane">
          <span className="fw-empty-icon" aria-hidden="true">
            <FolderOpen size={26} strokeWidth={1.4} />
          </span>
          <p>{t("fw.pane.noDir")}</p>
          <button
            type="button"
            className="btn sm"
            onClick={() => window.dispatchEvent(new CustomEvent("taskdock-fw-open-folder", { detail: paneId }))}
          >
            {t("fw.pane.openFolder")}
          </button>
        </div>
        <div className="fw-pane-status">
          <span className="fw-status-count">{t("fw.status.noDir")}</span>
          <span
            className="fw-pane-grip"
            data-tip={t("fw.pane.gripTip")}
            onPointerDown={(e) => beginDragCandidate(e, null, null, true)}
          >
            <GripVertical size={12} aria-hidden="true" />
          </span>
        </div>
        {dropHint?.type === "edge" && <span className={`fw-edge-hint fw-edge-${dropHint.edge}`} aria-hidden="true" />}
        {dropHint?.type === "center" && <span className="fw-center-hint" aria-hidden="true" />}
      </section>
    );
  }

  const dirError = dirState?.error === "DIR_MISSING" || (Boolean(dirState?.error) && !dirState?.listing);

  return (
    <section
      ref={paneRef}
      className={`fw-pane${isActivePane ? " is-active" : ""}`}
      data-fw-pane-id={paneId}
      data-fw-accept={dirPath}
      aria-label={t("fw.pane.aria", { path: dirPath })}
    >
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
            <button type="button" className="fw-crumbs-inner" onClick={() => setPathEdit(dirPath)} title={dirPath}>
              {crumbs.length <= 4 ? (
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
            </button>
          )}
        </div>

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
              { key: "newDir", label: t("fw.menu.newFolder"), onSelect: () => { setDialog({ kind: "newDir" }); setDialogInput(t("fw.menu.newFolderName")); } },
              { key: "newFile", label: t("fw.menu.newFile"), onSelect: () => { setDialog({ kind: "newFile" }); setDialogInput(t("fw.menu.newFileName")); } },
              { key: "dupTab", label: t("fw.tab.duplicate"), onSelect: () => store.getState().duplicateTab(paneId, tab.tabId) },
              { key: "closeTab", label: t("fw.tab.closeCurrent"), onSelect: () => store.getState().closeTab(paneId, tab.tabId) },
              { key: "swap", label: t("fw.pane.swap"), onSelect: () => store.getState().swapPane(paneId) },
              { key: "splitH", label: t("fw.pane.splitRight"), onSelect: () => store.getState().splitPane(paneId, "horizontal") },
              { key: "splitV", label: t("fw.pane.splitDown"), onSelect: () => store.getState().splitPane(paneId, "vertical") },
              { key: "closePane", label: t("fw.pane.close"), disabled: totalPanes <= 1, onSelect: () => store.getState().closePane(paneId) },
            ]}
          />
        </div>
      </div>

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
        />
      )}

      {/* 状态条 */}
      <div className="fw-pane-status">
        <span className="fw-status-count">
          {t("fw.status.items", { count: visibleEntries.length })}
          {selectedPaths.length > 0 ? ` · ${t("fw.status.selected", { count: selectedPaths.length })}` : ""}
        </span>
        {dirState?.truncated && <span className="fw-status-truncated">{t("fw.status.truncated")}</span>}
        <span className="fw-pane-grip" data-tip={t("fw.pane.gripTip")} onPointerDown={(e) => beginDragCandidate(e, null, null, true)}>
          <GripVertical size={12} aria-hidden="true" />
        </span>
      </div>

      {/* 应用内拖拽视觉提示层 */}
      {dropHint?.type === "edge" && <span className={`fw-edge-hint fw-edge-${dropHint.edge}`} aria-hidden="true" />}
      {dropHint?.type === "center" && <span className="fw-center-hint" aria-hidden="true" />}
      {dropHint?.type === "tabbar" && <span className="fw-tabbar-hint" aria-hidden="true" />}

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

      {/* 删除确认（回收站语义） */}
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        title={t("fw.dialog.deleteTitle", { count: menuSelection.length })}
        detail={t("fw.dialog.deleteBody")}
        confirmLabel={t("fw.dialog.deleteConfirm")}
        danger
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          const paths = [...menuSelection];
          setDialog(null);
          void doDelete(paths, false);
        }}
      />

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

