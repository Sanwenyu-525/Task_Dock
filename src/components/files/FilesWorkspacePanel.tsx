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
  FileText,
  Gamepad2,
  Clapperboard,
  FolderOpen,
} from "lucide-react";

import DropdownMenu from "../ui/DropdownMenu";
import { ConfirmDialog, Dialog } from "../ui/Dialog";
import Popover from "../ui/Popover";
import "./files.css";
import { useLocale } from "../../hooks/useLocale";
import { errorMessage } from "../../lib/errors";
import { isLogged, startOperation } from "../../lib/diagnostics";
import { showFsOpOutcome } from "./fsOpFeedback";
import {
  fsCopyPaths,
  fsMovePaths,
  fsDeletePaths,
  fsPlaces,
  type FsOpReport,
  type FsPlace,
} from "../../lib/bridge";
import {
  invalidateDirs,
} from "../../lib/filesWorkspace/dirCache";
import {
  LAYOUT_PRESETS,
  defaultTree,
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
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useWorkbenchPageActive } from "../../lib/windowHost";
import type { WorkspaceProject } from "../../lib/bridge";
import { parentOf } from "../../lib/filesWorkspace/pathUtils";

const FilePane = lazy(() => import("./FilePane"));

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
}

function SplitRender({ node, pageActive, maximizedPaneId, dropHintPane, dropHint, onHoverZone }: SplitRenderProps) {
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
    />
  );
}

function SplitWithDivider({
  node,
  pageActive,
  maximizedPaneId,
  dropHintPane,
  dropHint,
  onHoverZone,
}: SplitRenderProps & { node: Extract<SplitNode, { type: "split" }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const store = useFilesWorkspaceStore;
  const horizontal = node.direction === "horizontal";
  const minPx = horizontal ? MIN_PANE_W : MIN_PANE_H;

  const beginResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const size = horizontal ? rect.width : rect.height;
    const minRatio = Math.min(0.45, minPx / Math.max(size, minPx * 2));
    const maxRatio = 1 - minRatio;
    const startPos = horizontal ? event.clientX : event.clientY;
    const startRatio = node.ratio;
    document.body.classList.add("fw-resizing");
    const onMove = (e: PointerEvent) => {
      const pos = horizontal ? e.clientX : e.clientY;
      const delta = (pos - startPos) / Math.max(size, 1);
      store.getState().updateRatio(node.id, Math.min(maxRatio, Math.max(minRatio, startRatio + delta)));
    };
    const onUp = () => {
      document.body.classList.remove("fw-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const nudge = (delta: number) => {
    const el = ref.current;
    const size = el ? (horizontal ? el.getBoundingClientRect().width : el.getBoundingClientRect().height) : 1000;
    const minRatio = Math.min(0.45, minPx / Math.max(size, minPx * 2));
    store.getState().updateRatio(node.id, Math.min(1 - minRatio, Math.max(minRatio, node.ratio + delta)));
  };

  const firstStyle = horizontal ? { width: `${node.ratio * 100}%` } : { height: `${node.ratio * 100}%` };

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
        />
      </div>
      <div
        className={`fw-divider${horizontal ? " is-horizontal" : " is-vertical"}`}
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-label="调整分栏比例"
        aria-valuemin={15}
        aria-valuemax={85}
        aria-valuenow={Math.round(node.ratio * 100)}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            e.preventDefault();
            nudge(horizontal ? -0.03 : -0.03);
          } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            nudge(0.03);
          }
        }}
      />
      <div className="fw-split-child fw-split-child-second">
        <SplitRender
          node={node.second}
          pageActive={pageActive}
          maximizedPaneId={maximizedPaneId}
          dropHintPane={dropHintPane}
          dropHint={dropHint}
          onHoverZone={onHoverZone}
        />
      </div>
    </div>
  );
}

// ── 主面板 ──────────────────────────────────────────────────────────────

interface PanelProps {
  project: WorkspaceProject | null;
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
  const store = useFilesWorkspaceStore;

  const [dropHint, setDropHint] = useState<FwDropZone | null>(null);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const layoutBtnRef = useRef<HTMLButtonElement>(null);
  const [openFolderTarget, setOpenFolderTarget] = useState<string | null>(null);
  const [openFolderPath, setFolderPath] = useState("");
  const [places, setPlaces] = useState<FsPlace[]>([]);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [settingsRevision, setSettingsRevision] = useState(0);
  const hoverZoneRef = useRef<FwDropZone | null>(null);
  const hydrateGenRef = useRef(0);
  /** 已从持久化恢复过（true 后不再被「设置晚到补恢复」覆盖）。 */
  const savedHydratedRef = useRef(false);
  /** 键盘删除模式：Shift+Delete = 永久删除（独立确认语义）。 */
  const [deletePermanent, setDeletePermanent] = useState(false);

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

  // ── 快速位置 ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!openFolderTarget) return;
    void fsPlaces()
      .then(setPlaces)
      .catch(() => setPlaces([]));
  }, [openFolderTarget]);

  // 「打开文件夹」事件（空窗格 / + 按钮）
  useEffect(() => {
    const onOpen = (e: Event) => {
      const paneId = (e as CustomEvent<string>).detail;
      setFolderPath("");
      setOpenFolderTarget(paneId);
    };
    window.addEventListener("taskdock-fw-open-folder", onOpen);
    return () => window.removeEventListener("taskdock-fw-open-folder", onOpen);
  }, []);

  // ── 应用内拖拽：坐标/修饰键/落点派发/取消清理 ───────────────────────
  const applyFileDrop = useCallback(
    async (paths: string[], targetDir: string, effect: "copy" | "move"): Promise<FsOpReport | null> => {
      // 操作 ID 由前端生成、Rust 沿用：`Ok(report)` 里 failed>0 时 IPC 仍是成功，
      // 只有带着同一个 ID 的业务事件才能让「部分失败」在诊断中心可见且可关联。
      const op = startOperation("file", effect === "copy" ? "workspace_copy" : "workspace_move", {
        component: "文件工作区",
        metadata: { count: paths.length },
      });
      try {
        op.stage("ipc");
        const report: FsOpReport =
          effect === "copy"
            ? await fsCopyPaths(paths, targetDir, "rename", op.id)
            : await fsMovePaths(paths, targetDir, "rename", op.id);
        invalidateDirs([targetDir, ...paths.map((p) => parentOf(p) ?? "").filter(Boolean)]);
        // 业务终态由 Rust 写入诊断（同一 operation_id）；这里只负责把「失败了
        // 几项、主要原因是什么、下一步去哪里看」讲清楚，不重复上报同一故障。
        showFsOpOutcome({ effect, report, t, showToast });
        return report;
      } catch (e) {
        // IPC 抛错已由 invokeCommand 归属（含命令名/错误码）并 markLogged；
        // 只有未被归属的错误才补一条终态，不重复上报同一故障。
        if (!isLogged(e as object)) op.fail(e, { stage: "ipc" });
        showToast(errorMessage(e), { kind: "error" });
        return null;
      }
    },
    [showToast, t],
  );

  useEffect(() => {
    const clearHints = () => {
      hoverZoneRef.current = null;
      setDropHint(null);
    };
    const onMove = (e: PointerEvent) => {
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
      if (payload.kind === "tabs") {
        if (zone.type === "edge") {
          // 四方向分栏：左/上 = 前侧插入（树顺序必须与视觉一致，P0）。
          const direction: SplitDirection = zone.edge === "left" || zone.edge === "right" ? "horizontal" : "vertical";
          const side = zone.edge === "left" || zone.edge === "top" ? "before" : "after";
          if (payload.paneMove) {
            const newPaneId = s.splitPane(zone.paneId, direction, "", side);
            if (newPaneId) {
              for (const tabId of payload.tabIds) s.moveTabToPane(tabId, payload.fromPaneId, newPaneId);
              if (paneIds(s.tree).includes(payload.fromPaneId)) s.closePane(payload.fromPaneId);
            }
          } else {
            s.extractTabToPane(payload.tabIds[0], payload.fromPaneId, zone.paneId, direction, side);
          }
        } else if (zone.type === "center") {
          if (zone.paneId === payload.fromPaneId) return;
          if (payload.paneMove) {
            for (const tabId of payload.tabIds) s.moveTabToPane(tabId, payload.fromPaneId, zone.paneId);
            s.closePane(payload.fromPaneId);
          } else {
            s.moveTabToPane(payload.tabIds[0], payload.fromPaneId, zone.paneId);
          }
        } else if (zone.type === "tabbar") {
          if (zone.paneId === payload.fromPaneId && !payload.paneMove) {
            const tabs = s.panes[payload.fromPaneId]?.tabs ?? [];
            const curIdx = tabs.findIndex((x) => x.tabId === payload.tabIds[0]);
            let to = zone.index;
            if (curIdx >= 0 && to > curIdx) to -= 1;
            if (curIdx >= 0 && to !== curIdx) s.reorderTab(payload.fromPaneId, curIdx, to);
          } else if (zone.paneId !== payload.fromPaneId) {
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
      void applyFileDrop(payload.paths, targetDir, effect === "copy" ? "copy" : "move");
    };
    // 取消通道：Escape / pointercancel / 窗口失焦 / 指针离开窗口 / 卸载。
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
    const onLeaveDoc = (e: PointerEvent) => {
      if (!e.relatedTarget) onCancel();
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
  }, [applyFileDrop, store]);

  // hover zone 上报（来自各 Pane）：仅变化时 setState（拖拽中每帧 emit 不再牵动整树）。
  const onHoverZone = useCallback((zone: FwDropZone | null) => {
    if (sameZone(zone, hoverZoneRef.current)) return;
    hoverZoneRef.current = zone;
    setDropHint(zone);
  }, []);

  // ── 外部 OS 拖入（fileDrop 仲裁认领）────────────────────────────────
  useEffect(() => {
    const hitPaneDir = (point: { x: number; y: number } | null): string | null => {
      if (!point) return null;
      const paneId = dropTargetAt(point, "data-fw-pane-id");
      if (!paneId) return null;
      const s = store.getState();
      const pane = s.panes[paneId];
      const dir = pane?.tabs.find((x) => x.tabId === pane.activeTabId)?.path;
      return dir ?? null;
    };
    const consumer = {
      id: "files-workspace",
      priority: 20,
      claim: () => pageActive,
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
        const dir = hitPaneDir(point);
        if (!dir || paths.length === 0) {
          if (paths.length > 0) showToast(t("fw.error.dropOutside"), { kind: "warning" });
          return;
        }
        void applyFileDrop(paths, dir, "copy");
      },
      onPayload: (payload: DragPayloadView, point: { x: number; y: number } | null, meta: { operationId: string }) => {
        onHoverZone(null);
        if (payload.kind === "local-files" && payload.paths.length) {
          const dir = hitPaneDir(point);
          if (!dir) {
            void discardOperation(meta.operationId, "files-workspace-no-pane");
            showToast(t("fw.error.dropOutside"), { kind: "warning" });
            return;
          }
          // 外部来源恒为复制语义：绝不删用户源文件；消费后释放后端会话。
          void applyFileDrop(payload.paths, dir, "copy").then(() =>
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
  }, [applyFileDrop, pageActive, showToast, store, t]);

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
      const s = store.getState();
      const paneId = s.activePaneId;
      const pane = s.panes[paneId];
      const tab = pane?.tabs.find((x) => x.tabId === pane?.activeTabId);
      if (!tab) return;
      const selection = s.selection[paneId]?.paths ?? [];
      const mod = e.ctrlKey || e.metaKey;
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
        setFwClipboard({ mode: "copy", paths: [...selection] });
        showToast(t("fw.report.clipCopy", { count: selection.length }), { kind: "info" });
      } else if (mod && (e.key === "x" || e.key === "X") && selection.length) {
        e.preventDefault();
        setFwClipboard({ mode: "cut", paths: [...selection] });
        showToast(t("fw.report.clipCut", { count: selection.length }), { kind: "info" });
      } else if (mod && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        void (async () => {
          const clip = getFwClipboard();
          if (!clip) return;
          const report = await applyFileDrop(clip.paths, tab.path, clip.mode === "copy" ? "copy" : "move");
          if (clip.mode === "cut") {
            // 剪切语义（P0：失败不得静默清空剪切状态）：部分失败只保留未完成项。
            // 失败与「部分完成」都视为源仍在：保留在剪切待办，成功项才移出。
            const pending = report
              ? report.entries
                  .filter((r) => r.status === "failed" || r.status === "partial")
                  .map((r) => r.source)
              : [...clip.paths];
            setFwClipboard(pending.length ? { mode: "cut", paths: pending } : null);
          }
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
  }, [pageActive, hydrated, activePaneId, applyFileDrop]);

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
      void applyFileDrop(paths, dir, detail.mode === "move" ? "move" : "copy");
    };
    window.addEventListener("taskdock-fw-deliver", onDeliver);
    return () => window.removeEventListener("taskdock-fw-deliver", onDeliver);
  }, [applyFileDrop, showToast, store, t]);

  // ── 布局动作 ────────────────────────────────────────────────────────
  const applyPreset = (presetId: string) => {
    const rootPath = project?.rootPath ?? "";
    store.getState().applyPreset(presetId, rootPath ? [rootPath] : []);
    setLayoutOpen(false);
  };

  const applyBuiltinTemplate = (presetId: string) => {
    // 内置模板只恢复布局形状；示例目录不作为真实路径（任务规范 §8.2）。
    applyPreset(presetId);
  };

  const applyCustomTemplate = (templateId: string) => {
    store.getState().applyTemplate(
      templateId,
      persisted.templates.map((tpl) => ({ id: tpl.id, tree: tpl.tree, panes: tpl.panes })),
    );
    void store
      .getState()
      .persistNow()
      .catch(() => {});
    setLayoutOpen(false);
  };

  const submitSaveTemplate = async () => {
    const name = templateName.trim();
    if (!name) return;
    try {
      await store.getState().saveCurrentAsTemplate(name);
      showToast(t("fw.template.saved", { name }), { kind: "success" });
      setSaveTemplateOpen(false);
      setTemplateName("");
      setSettingsRevision((n) => n + 1);
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  };

  const submitOpenFolder = () => {
    const path = openFolderPath.trim();
    if (!path || !openFolderTarget) return;
    store.getState().openInPane(openFolderTarget, path, "newTab");
    setOpenFolderTarget(null);
  };

  const paneCount = paneIds(tree).length;
  const activeDir =
    panes[activePaneId]?.tabs.find((x) => x.tabId === panes[activePaneId]?.activeTabId)?.path ?? "";
  void activeDir;

  const moreItems = [
    { key: "maximize", label: maximizedPaneId ? t("fw.layout.restoreMax") : t("fw.layout.maximize"), icon: maximizedPaneId ? <Minimize2 size={13} /> : <Maximize2 size={13} />, disabled: paneCount <= 1, onSelect: () => store.getState().toggleMaximize(activePaneId) },
    { key: "closeOthers", label: t("fw.layout.closeOthers"), disabled: paneCount <= 1, onSelect: () => { for (const id of paneIds(tree)) { if (id !== activePaneId) store.getState().closePane(id); } } },
    { key: "reset", label: t("fw.layout.resetDefault"), onSelect: () => applyPreset("single") },
    { key: "refreshAll", label: t("fw.layout.refreshAll"), onSelect: () => invalidateDirs(paneIds(tree).map((id) => panes[id]?.tabs.find((x) => x.tabId === panes[id]?.activeTabId)?.path ?? "").filter(Boolean)) },
  ];

  if (!hydrated) {
    return <div className="fw-root fw-root-boot" role="status" aria-label={t("nav.loading")} />;
  }

  return (
    <div className="fw-root">
      {/* 顶部工具栏（不重复 Shell 既有功能） */}
      <header className="fw-toolbar">
        <div className="fw-toolbar-title">
          <span className="fw-toolbar-name">{t("fw.title")}</span>
          {project && (
            <span className="fw-toolbar-project" data-tip={project.rootPath || undefined}>
              <FolderOpen size={12} aria-hidden="true" />
              {project.name}
            </span>
          )}
        </div>

        <div className="fw-toolbar-actions">
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setFolderPath("");
              setOpenFolderTarget(activePaneId);
            }}
          >
            <FolderPlus size={13} aria-hidden="true" />
            {t("fw.toolbar.addFolder")}
          </button>

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
              { key: "single", label: t("fw.preset.single"), icon: <Square size={13} />, onSelect: () => applyPreset("single") },
              { key: "leftRight", label: t("fw.preset.leftRight"), icon: <Columns2 size={13} />, onSelect: () => applyPreset("leftRight") },
              { key: "topBottom", label: t("fw.preset.topBottom"), icon: <Rows2 size={13} />, onSelect: () => applyPreset("topBottom") },
              { key: "threeLeft", label: t("fw.preset.three"), icon: <Columns3 size={13} />, onSelect: () => applyPreset("threeLeft") },
              { key: "quad", label: t("fw.preset.quad"), icon: <LayoutGrid size={13} />, onSelect: () => applyPreset("quad") },
              { key: "sep", label: "" },
              { key: "customize", label: t("fw.layout.customizeHint"), description: t("fw.layout.customizeBody"), onSelect: () => setLayoutOpen(true) },
            ]}
          />

          <button
            ref={layoutBtnRef}
            type="button"
            className={`btn sm${layoutOpen ? " is-on" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={layoutOpen}
            onClick={(e) => {
              e.stopPropagation();
              setLayoutOpen((v) => !v);
            }}
          >
            <LayoutPanelTop size={13} aria-hidden="true" />
            {t("fw.toolbar.templates")}
          </button>

          <button type="button" className="btn sm" onClick={() => setSaveTemplateOpen(true)}>
            <Save size={13} aria-hidden="true" />
            {t("fw.toolbar.saveLayout")}
          </button>

          <DropdownMenu
            menuLabel={t("fw.toolbar.more")}
            placement="bottom-end"
            trigger={({ ref, expanded, onClick, onKeyDown }) => (
              <button ref={ref} type="button" className="fw-icon-btn" aria-haspopup="menu" aria-expanded={expanded} aria-label={t("fw.toolbar.more")} onClick={onClick} onKeyDown={onKeyDown}>
                <MoreHorizontal size={15} aria-hidden="true" />
              </button>
            )}
            items={moreItems}
          />
        </div>
      </header>

      {/* 主区域：最大化单窗格或完整分割树 */}
      <div className="fw-workarea">
        {maximizedPaneId && panes[maximizedPaneId] ? (
          <SplitRender
            node={{ type: "pane", paneId: maximizedPaneId }}
            pageActive={pageActive}
            maximizedPaneId={maximizedPaneId}
            dropHintPane={dropHint?.paneId ?? null}
            dropHint={dropHint}
            onHoverZone={onHoverZone}
          />
        ) : (
          <SplitRender
            node={tree}
            pageActive={pageActive}
            maximizedPaneId={null}
            dropHintPane={dropHint?.paneId ?? null}
            dropHint={dropHint}
            onHoverZone={onHoverZone}
          />
        )}
      </div>

      {/* 布局抽屉（非侵入 Popover） */}
      <Popover
        open={layoutOpen}
        onOpenChange={setLayoutOpen}
        anchorRef={layoutBtnRef}
        placement="bottom-end"
        className="fw-layout-pop"
        role="dialog"
      >
        <div className="fw-layout-drawer" onPointerDown={(e) => e.stopPropagation()}>
          <div className="fw-drawer-section">
            <h3 className="fw-drawer-title">{t("fw.layout.presets")}</h3>
            <div className="fw-preset-grid">
              {Object.values(LAYOUT_PRESETS).map((preset) => (
                <button key={preset.id} type="button" className="fw-preset-item" onClick={() => applyPreset(preset.id)}>
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <div className="fw-drawer-section">
            <h3 className="fw-drawer-title">{t("fw.layout.builtinTemplates")}</h3>
            <div className="fw-template-list">
              <button type="button" className="fw-template-item" onClick={() => applyBuiltinTemplate("leftRight")}>
                <Columns2 size={14} aria-hidden="true" />
                {t("fw.builtin.general")}
              </button>
              <button type="button" className="fw-template-item" onClick={() => applyBuiltinTemplate("quad")}>
                <FileText size={14} aria-hidden="true" />
                {t("fw.builtin.dev")}
              </button>
              <button type="button" className="fw-template-item" onClick={() => applyBuiltinTemplate("quad")}>
                <Gamepad2 size={14} aria-hidden="true" />
                {t("fw.builtin.game")}
              </button>
              <button type="button" className="fw-template-item" onClick={() => applyBuiltinTemplate("quad")}>
                <Clapperboard size={14} aria-hidden="true" />
                {t("fw.builtin.comic")}
              </button>
            </div>
          </div>
          {persisted.templates.length > 0 && (
            <div className="fw-drawer-section">
              <h3 className="fw-drawer-title">{t("fw.layout.myTemplates")}</h3>
              <div className="fw-template-list">
                {persisted.templates.map((tpl) => (
                  <button key={tpl.id} type="button" className="fw-template-item" onClick={() => applyCustomTemplate(tpl.id)}>
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

      {/* 打开文件夹对话框 */}
      <Dialog
        open={openFolderTarget !== null}
        onClose={() => setOpenFolderTarget(null)}
        title={t("fw.dialog.openFolder")}
        size="sm"
        ariaLabel={t("fw.dialog.openFolder")}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setOpenFolderTarget(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary" disabled={!openFolderPath.trim()} onClick={submitOpenFolder}>
              {t("common.confirm")}
            </button>
          </>
        }
      >
        <label className="fw-dialog-field">
          <span>{t("fw.dialog.folderPath")}</span>
          <input
            className="ws-input"
            value={openFolderPath}
            autoFocus
            placeholder={t("fw.dialog.folderPlaceholder")}
            onChange={(e) => setFolderPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitOpenFolder();
            }}
          />
        </label>
        {places.length > 0 && (
          <div className="fw-places">
            {places.map((place) => (
              <button
                key={place.path}
                type="button"
                className="fw-place"
                onClick={() => setFolderPath(place.path)}
              >
                <FolderOpen size={13} aria-hidden="true" />
                <span>{place.name}</span>
              </button>
            ))}
          </div>
        )}
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
              op.stage("ipc");
              const report = await fsDeletePaths(paths, permanent, op.id);
              invalidateDirs(paths.map((p) => parentOf(p) ?? "").filter(Boolean));
              showFsOpOutcome({
                effect: permanent ? "deletePermanent" : "deleteRecycle",
                report,
                t,
                showToast,
              });
              store.getState().clearSelection(store.getState().activePaneId);
            } catch (e) {
              showToast(errorMessage(e), { kind: "error" });
            }
          })();
        }}
      />

      {/* 拖拽 ghost（独立订阅组件：每帧位置更新只重渲染自身） */}
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
  const denied = st.payload.kind === "files" && !st.hover;
  const text =
    st.payload.kind === "tabs"
      ? st.payload.paneMove
        ? t("fw.drag.movePane", { count: st.payload.tabIds.length })
        : t("fw.drag.mergeTabs", { count: st.payload.tabIds.length })
      : st.effect === "copy"
        ? t("fw.drag.copy", { count: st.payload.paths.length })
        : t("fw.drag.move", { count: st.payload.paths.length });
  return (
    <div
      className={`fw-drag-ghost${st.payload.kind === "tabs" ? " is-tabs" : ""}${denied ? " is-denied" : ""}`}
      style={{ left: st.x, top: st.y }}
      aria-hidden="true"
    >
      {text}
    </div>
  );
}

/** 其他模块 / 未来 Agent 的显式入口：在活动窗格打开指定目录（新标签）。 */
export function openFilesWorkspacePath(path: string): void {
  useFilesWorkspaceStore.getState().openPathInActive(path, "newTab");
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
