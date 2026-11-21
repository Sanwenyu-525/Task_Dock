//! 全局工作篮面板（工作台固定列 / 主窗口与窄窗抽屉共用）。
//!
//! 只做展示与交互编排：条目读写走 `useTransferStore`，发送前预览与执行走
//! `TransferConfirmDialog`（快照一致性由它保证），不在组件里复制任何文件操作逻辑。
//!
//! 单实例：一个窗口同一时间只允许一个 `TransferPanel` 挂载。固定列与抽屉的互斥
//! 由 `panelMode` 决定，这里是第二道守卫（防止调用方同时渲染两个入口）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronDown,
  File as FileIcon,
  Folder,
  Image as ImageIcon,
  Link2,
  Loader2,
  MoreHorizontal,
  Package,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { clipboardView } from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import type { ClipboardItem } from "../../lib/contracts/models";
import { errorMessage } from "../../lib/errors";
import { Dialog } from "../ui/Dialog";
import DropdownMenu, { type DropdownMenuItem } from "../ui/DropdownMenu";
import { useOverlayLayer } from "../ui/overlay";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { useTransferStore } from "../../store/useTransferStore";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import { addClipboardItemsToTray } from "../../lib/crossTab/modules/clipboard";
import { resolvePathInputs } from "../../lib/crossTab/fileKinds";
import { rejectionLines } from "../../lib/crossTab/addResult";
import { fsStat } from "../../lib/bridge";
import { CREATE_TASK_ACTION_ID } from "../../lib/crossTab/modules/tasks";
import { ADD_TO_TRAY_ACTION } from "../../lib/crossTab/modules/tray";
import { executeAction, getAction, resolveAvailableActions } from "../../lib/crossTab/actionRegistry";
import * as client from "../../lib/crossTab/transferClient";
import type {
  TransferAddResult,
  TransferOptions,
  TransferRejection,
  TransferTarget,
} from "../../lib/crossTab/types";
import type { Notify } from "./ActionDispatcher";
import SendToMenu from "./SendToMenu";
import TargetPicker from "./TargetPicker";
import TransferConfirmDialog from "./TransferConfirmDialog";
import "./transfer.css";

const TARGET_KEY = "taskdock.transfer.target.v1";

function readTarget(): string {
  try {
    return localStorage.getItem(TARGET_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeTarget(path: string): void {
  try {
    localStorage.setItem(TARGET_KEY, path);
  } catch {
    // 存储被禁用时只保留本次会话目标。
  }
}

const TYPE_FILTERS: Array<{ id: string; labelKey: string; types: string[] }> = [
  { id: "all", labelKey: "transfer.filterAll", types: [] },
  { id: "text", labelKey: "transfer.filterText", types: ["text", "richtext"] },
  { id: "image", labelKey: "transfer.filterImage", types: ["image"] },
  { id: "file", labelKey: "transfer.filterFile", types: ["file", "directory"] },
  { id: "url", labelKey: "transfer.filterUrl", types: ["url"] },
  { id: "entity", labelKey: "transfer.filterEntity", types: ["task", "project", "planning", "knowledge", "capture", "clipboard"] },
];

/** 托盘内排序的拖拽类型（只在本面板内消费，不对外承诺）。 */
const TRAY_DRAG_MIME = "application/x-taskdock-tray-item";

function itemIcon(type: string) {
  switch (type) {
    case "image":
      return <ImageIcon size={14} aria-hidden="true" />;
    case "file":
      return <FileIcon size={14} aria-hidden="true" />;
    case "directory":
      return <Folder size={14} aria-hidden="true" />;
    case "url":
      return <Link2 size={14} aria-hidden="true" />;
    case "text":
    case "richtext":
      return <Type size={14} aria-hidden="true" />;
    default:
      return <Package size={14} aria-hidden="true" />;
  }
}

function batchTone(status: string): string {
  if (status === "completed") return "ok";
  if (status === "partial") return "warn";
  if (status === "failed" || status === "cancelled") return "bad";
  return "running";
}

function previewText(entry: { content: string; payload: Record<string, unknown> }): string {
  if (entry.content.trim()) return entry.content.trim();
  const path = entry.payload?.path;
  const url = entry.payload?.url;
  if (typeof path === "string") return path;
  if (typeof url === "string") return url;
  return "";
}

/** 单实例守卫：同一窗口第二个面板实例直接不渲染。 */
let mountedPanels = 0;

interface TransferPanelProps {
  variant: "dock" | "drawer";
  host?: "main" | "workbench";
  onClose: () => void;
}

export default function TransferPanel({ variant, host = "workbench", onClose }: TransferPanelProps) {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const items = useTransferStore((s) => s.items);
  const total = useTransferStore((s) => s.total);
  const selection = useTransferStore((s) => s.selection);
  const filter = useTransferStore((s) => s.filter);
  const panel = useTransferStore((s) => s.panel);
  const context = useTransferStore((s) => s.context);
  const activeBatch = useTransferStore((s) => s.activeBatch);
  const monitorState = useTransferStore((s) => s.monitorState);
  const monitorError = useTransferStore((s) => s.monitorError);
  const busy = useTransferStore((s) => s.busy);
  const loading = useTransferStore((s) => s.loading);
  const error = useTransferStore((s) => s.error);
  const lastRemoved = useTransferStore((s) => s.lastRemoved);

  const [tab, setTab] = useState<"tray" | "clipboard">("tray");
  const [target, setTarget] = useState(readTarget);
  const [targetValid, setTargetValid] = useState(false);
  const [targetMessage, setTargetMessage] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sendOptions, setSendOptions] = useState<TransferOptions>(client.DEFAULT_OPTIONS);
  const panelRef = useRef<HTMLElement>(null);
  const [clipItems, setClipItems] = useState<ClipboardItem[]>([]);
  const [clipSelected, setClipSelected] = useState<string[]>([]);
  const [clipQuery, setClipQuery] = useState("");
  const [clipLoading, setClipLoading] = useState(false);
  const [clipError, setClipError] = useState("");
  const [limit, setLimit] = useState(80);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addReport, setAddReport] = useState<TransferAddResult | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [batchDetailOpen, setBatchDetailOpen] = useState(false);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  const [ownsInstance] = useState(() => {
    mountedPanels += 1;
    return mountedPanels === 1;
  });
  useEffect(() => {
    return () => {
      mountedPanels = Math.max(0, mountedPanels - 1);
    };
  }, []);

  const filesPanes = useFilesWorkspaceStore((s) => s.panes);
  const filesActivePaneId = useFilesWorkspaceStore((s) => s.activePaneId);
  const filesSelectionMap = useFilesWorkspaceStore((s) => s.selection);
  const filesSelection = useMemo(
    () => (filesPanes[filesActivePaneId] ? (filesSelectionMap[filesActivePaneId]?.paths ?? []) : []),
    [filesPanes, filesActivePaneId, filesSelectionMap],
  );

  // 抽屉形态注册到统一弹层栈：Escape 只关工作篮，不直接隐藏窗口。
  useOverlayLayer("drawer", variant === "drawer", onClose, panelRef);

  const notify: Notify = useCallback(
    (message, kind = "info") => showToast(message, { kind }),
    [showToast],
  );

  useEffect(() => {
    if (!ownsInstance) return;
    // 首次加载一次；dock / drawer 切换导致的重挂载不会重复请求后端。
    void useTransferStore.getState().ensureLoaded();
  }, [ownsInstance]);

  // 目标目录：没有持久化值时跟随当前上下文目录（只做推荐，不自动写入）。
  useEffect(() => {
    if (!ownsInstance || !context.directory) return;
    if (readTarget()) return;
    setTarget(context.directory);
    writeTarget(context.directory);
  }, [ownsInstance, context.directory]);

  useEffect(() => {
    if (!ownsInstance || tab !== "clipboard") return;
    let alive = true;
    const timer = window.setTimeout(() => {
      setClipLoading(true);
      setClipError("");
      void clipboardView({ search: clipQuery.trim() || undefined, limit: 120 })
        .then((view) => {
          if (!alive) return;
          setClipItems(view.items);
        })
        .catch((e) => {
          if (!alive) return;
          setClipError(errorMessage(e));
        })
        .finally(() => {
          if (alive) setClipLoading(false);
        });
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [ownsInstance, tab, clipQuery]);

  const visible = useMemo(() => {
    const rows = items.filter((item) => item.status !== "sent" || item.pinned);
    return rows.slice(0, limit);
  }, [items, limit]);

  const selectedCount = selection.length;
  const selectedItems = useMemo(
    () => items.filter((item) => selection.includes(item.id)),
    [items, selection],
  );
  const allVisibleSelected = visible.length > 0 && visible.every((item) => selection.includes(item.id));
  const allClipSelected = clipItems.length > 0 && clipItems.every((item) => clipSelected.includes(item.id));

  const selectedTextItems = useMemo(
    () => items.filter((item) => selection.includes(item.id) && item.content.trim().length > 0),
    [items, selection],
  );

  const sendTarget: TransferTarget | null = target.trim() ? { module: "files", ref: target } : null;

  function toggleType(id: string) {
    const filterDef = TYPE_FILTERS.find((entry) => entry.id === id);
    if (!filterDef) return;
    useTransferStore.getState().setItemTypes(filterDef.types);
  }

  function reportAdd(result: TransferAddResult) {
    setAddReport(result);
    const rejected = result.rejected.length;
    if (result.added === 0) {
      // 全部失败：绝不显示绿色成功提示。
      setReportOpen(true);
      notify(
        rejected > 0
          ? t("transfer.addOutcomeFailed", { rejected, duplicates: result.duplicates })
          : t("transfer.addFailedAll", { count: rejected }),
        "error",
      );
      return;
    }
    if (rejected > 0 || result.duplicates > 0) {
      notify(
        t("transfer.addOutcomePartial", {
          added: result.added,
          duplicates: result.duplicates,
          rejected,
        }),
        "warning",
      );
      if (rejected > 0) setReportOpen(true);
      return;
    }
    notify(t("transfer.added", { count: result.added }), "success");
  }

  function failedReport(rejections: TransferRejection[]): TransferAddResult {
    return { added: 0, duplicates: 0, rejected: rejections, items: [] };
  }

  async function addPaths(paths: string[], sourceModule: string) {
    if (paths.length === 0) return;
    try {
      const resolved = await resolvePathInputs(paths, fsStat, sourceModule);
      if (resolved.inputs.length === 0) {
        reportAdd(failedReport(resolved.rejected));
        return;
      }
      const result = await useTransferStore.getState().add(resolved.inputs);
      reportAdd({
        ...result,
        rejected: [...resolved.rejected, ...result.rejected],
      });
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }

  async function addFilesSelection() {
    await addPaths(filesSelection, "files");
  }

  async function addClipboardSelected() {
    if (clipSelected.length === 0) return;
    try {
      const { report, rejected } = await addClipboardItemsToTray(clipSelected);
      if (!report) {
        reportAdd(failedReport(rejected));
        return;
      }
      reportAdd({
        added: report.items.length,
        duplicates: report.duplicates,
        rejected: [...rejected, ...(report.rejected ?? [])],
        items: report.items,
      });
      await useTransferStore.getState().refresh();
      setClipSelected([]);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }

  function handleTargetChange(path: string) {
    setTarget(path);
    writeTarget(path);
    if (path) void client.updateContext({ directory: path });
  }

  async function removeSelected() {
    if (selectedCount === 0) return;
    try {
      const removed = await useTransferStore.getState().remove(selection);
      notify(t("transfer.removedUndoable", { count: removed }), "info");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }

  async function undoRemove() {
    try {
      const restored = await useTransferStore.getState().undoRemove();
      notify(t("transfer.restored", { count: restored }), restored > 0 ? "success" : "warning");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }

  async function clearTemporary() {
    try {
      const removed = await useTransferStore.getState().clearTemporary();
      notify(t("transfer.cleared", { count: removed }), "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }

  async function retryBatch() {
    try {
      const next = await useTransferStore.getState().retry();
      if (next) notify(t("transfer.retried"), "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }

  async function undoBatch() {
    if (!activeBatch) return;
    try {
      const result = await useTransferStore.getState().undo(activeBatch.id);
      notify(result.message, result.ok ? "success" : "warning");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }

  function togglePinned() {
    useTransferStore.getState().togglePinnedPanel();
    const next = useTransferStore.getState();
    if (!next.panel.pinned) {
      notify(t("transfer.pinDisabledWidth"), "info");
      return;
    }
    if (host === "main") {
      notify(t("transfer.pinMainWindow"), "info");
      return;
    }
    if (next.panelMode === "dock") notify(t("transfer.pinEnabled"), "success");
    else notify(t("transfer.pinDisabledWidth"), "info");
  }

  async function createTaskFromSelection() {
    const action = getAction(CREATE_TASK_ACTION_ID);
    if (!action) {
      notify(t("transfer.actionUnavailable"), "warning");
      return;
    }
    const result = await executeAction(CREATE_TASK_ACTION_ID, {
      items: selectedItems,
      context: useTransferStore.getState().context,
    });
    notify(result.message, result.ok ? "success" : "error");
    if (result.ok) useTransferStore.getState().clearSelection();
  }

  async function copySelectedText() {
    if (selectedTextItems.length === 0) return;
    const ok = await copyText(selectedTextItems.map((item) => item.content).join("\n\n"));
    notify(
      ok ? t("transfer.copied", { count: selectedTextItems.length }) : t("transfer.copyFailed"),
      ok ? "success" : "error",
    );
  }

  // ── 拖拽：托盘内排序（真实接收端）+ 外部文本/链接投放 ────────────────
  function moveDraggedBefore(draggedId: string, targetId: string | null) {
    const order = visible.map((item) => item.id).filter((id) => id !== draggedId);
    const index = targetId ? order.indexOf(targetId) : order.length;
    order.splice(index < 0 ? order.length : index, 0, draggedId);
    void useTransferStore.getState().reorder(order);
  }

  function handleRowDrop(event: React.DragEvent, targetId: string | null) {
    const internal = dragIdRef.current;
    dragIdRef.current = null;
    setDropTargetId(null);
    if (internal) {
      event.preventDefault();
      moveDraggedBefore(internal, targetId);
      return;
    }
    const text = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (!text.trim()) {
      notify(t("transfer.dropUnsupported"), "warning");
      return;
    }
    event.preventDefault();
    const urls = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const isUrl = urls.length > 0 && urls.every((line) => /^https?:\/\//i.test(line));
    const inputs = isUrl
      ? urls.map((url) => ({
          itemType: "url" as const,
          sourceModule: "manual" as const,
          sourceId: url,
          title: url,
          content: url,
          payload: { url },
        }))
      : [
          {
            itemType: "text" as const,
            sourceModule: "manual" as const,
            sourceId: "",
            title: text.split(/\r?\n/)[0]?.slice(0, 80) || t("transfer.untitled"),
            content: text,
            payload: {},
          },
        ];
    void useTransferStore
      .getState()
      .add(inputs)
      .then(reportAdd)
      .catch((e) => notify(errorMessage(e), "error"));
  }

  const canCreateTask = useMemo(() => {
    const action = getAction(CREATE_TASK_ACTION_ID);
    if (!action || selectedCount === 0) return false;
    return resolveAvailableActions(selectedItems, useTransferStore.getState().context).some(
      (entry) => entry.actionId === CREATE_TASK_ACTION_ID,
    );
  }, [selectedCount, selectedItems]);

  const moreItems: DropdownMenuItem[] = [];
  if (canCreateTask) {
    moreItems.push({
      key: "create-task",
      label: t("transfer.actionCreateTask"),
      icon: <FileIcon size={12} aria-hidden="true" />,
      onSelect: () => void createTaskFromSelection(),
    });
  }
  moreItems.push(
    {
      key: "clear-temporary",
      label: t("transfer.clearTemporary"),
      icon: <Trash2 size={12} aria-hidden="true" />,
      onSelect: () => void clearTemporary(),
    },
    {
      key: "refresh",
      label: t("transfer.refresh"),
      icon: <RefreshCw size={12} aria-hidden="true" />,
      onSelect: () => void useTransferStore.getState().refresh(),
    },
  );
  if (filesSelection.length > 0) {
    moreItems.push({
      key: "add-files-selection",
      label: t("transfer.addFilesSelection", { count: filesSelection.length }),
      icon: <FileIcon size={12} aria-hidden="true" />,
      onSelect: () => void addFilesSelection(),
    });
  }
  if (selectedTextItems.length > 0) {
    moreItems.push({
      key: "copy-selected-text",
      label: t("transfer.copySelected", { count: selectedTextItems.length }),
      icon: <Type size={12} aria-hidden="true" />,
      onSelect: () => void copySelectedText(),
    });
  }

  // 进度单位 = 条目（合并文本也按条目计），并做上限收敛，绝不超过 100%。
  const batchDone = activeBatch ? activeBatch.ok + activeBatch.failed + activeBatch.skipped : 0;
  const batchProgress =
    activeBatch && activeBatch.total > 0
      ? Math.min(100, Math.round((batchDone / activeBatch.total) * 100))
      : 0;

  if (!ownsInstance) return null;

  return (
    <aside ref={panelRef} className={`tp-panel tp-${variant}`} aria-label={t("transfer.title")}>
      <header className="tp-head">
        <div className="tp-head-main">
          <span className="tp-title">
            <Archive size={15} aria-hidden="true" /> {t("transfer.title")}
          </span>
          <span className="tp-count" data-tip={t("transfer.countHint")}>
            {selectedCount > 0 ? t("transfer.selected", { count: selectedCount }) : `${total}`}
          </span>
        </div>
        <div className="tp-head-actions">
          <button
            type="button"
            className="icon-btn sm"
            aria-label={panel.pinned ? t("transfer.unpinPanel") : t("transfer.pinPanel")}
            aria-pressed={panel.pinned}
            data-tip={panel.pinned ? t("transfer.pinPanelHint") : t("transfer.pinPanelHint")}
            onClick={togglePinned}
          >
            {panel.pinned ? <Pin size={13} /> : <PinOff size={13} />}
          </button>
          <DropdownMenu
            menuLabel={t("transfer.more")}
            side="bottom"
            alignment="end"
            items={moreItems}
            trigger={({ ref, expanded, onClick, onKeyDown }) => (
              <button
                ref={ref}
                type="button"
                className="icon-btn sm"
                aria-label={t("transfer.more")}
                aria-expanded={expanded}
                data-tip={t("transfer.moreHint")}
                onClick={onClick}
                onKeyDown={onKeyDown}
              >
                <MoreHorizontal size={13} />
              </button>
            )}
          />
          <button
            type="button"
            className="icon-btn sm"
            aria-label={t("transfer.closePanel")}
            data-tip={t("transfer.closePanel")}
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </div>
        {context.module && (
          <p className="tp-context" data-tip={context.directory ?? context.projectId ?? ""}>
            {t("transfer.context")} {context.directory || context.projectId || context.module}
          </p>
        )}
      </header>

      <div className="tp-tabs" role="tablist" aria-label={t("transfer.title")}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "tray"}
          className={`tp-tab${tab === "tray" ? " is-active" : ""}`}
          onClick={() => setTab("tray")}
        >
          {t("transfer.trayTab")} <span className="tp-tab-count">{total}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "clipboard"}
          className={`tp-tab${tab === "clipboard" ? " is-active" : ""}`}
          onClick={() => setTab("clipboard")}
        >
          {t("transfer.clipboardTab")}
        </button>
      </div>

      {tab === "tray" ? (
        <>
          <div className="tp-tools">
            <label className="tp-search">
              <Search size={13} aria-hidden="true" />
              <input
                value={filter.search}
                placeholder={t("transfer.searchPlaceholder")}
                onChange={(event) => useTransferStore.getState().setSearch(event.target.value)}
              />
            </label>
            <div className="tp-filters" role="group" aria-label={t("transfer.filterLabel")}>
              {TYPE_FILTERS.map((entry) => {
                const active =
                  entry.types.length === 0
                    ? filter.itemTypes.length === 0
                    : entry.types.length === filter.itemTypes.length &&
                      entry.types.every((type) => filter.itemTypes.includes(type));
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`tp-chip${active ? " is-active" : ""}`}
                    aria-pressed={active}
                    onClick={() => toggleType(entry.id)}
                  >
                    {t(entry.labelKey as never)}
                  </button>
                );
              })}
            </div>
            <div className="tp-selection-bar">
              <label className="tp-check-all">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  aria-label={t("transfer.selectAll")}
                  onChange={(event) =>
                    event.target.checked
                      ? useTransferStore.getState().selectAllVisible()
                      : useTransferStore.getState().clearSelection()
                  }
                />
                {t("transfer.selectAll")}
              </label>
              <button type="button" className="tp-link" onClick={() => useTransferStore.getState().invertSelection()}>
                {t("transfer.selectInvert")}
              </button>
              <button
                type="button"
                className="tp-link"
                disabled={selectedCount === 0}
                onClick={() => useTransferStore.getState().clearSelection()}
              >
                {t("transfer.clearSelection")}
              </button>
            </div>
          </div>

          {lastRemoved && lastRemoved.items.length > 0 && (
            <div className="tp-undo-bar" role="status">
              <span>{t("transfer.removedUndoable", { count: lastRemoved.items.length })}</span>
              <div className="tp-undo-actions">
                <button type="button" className="tp-link" onClick={() => void undoRemove()}>
                  {t("transfer.undoRemove")}
                </button>
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label={t("transfer.dismiss")}
                  onClick={() => useTransferStore.getState().dismissRemoved()}
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          )}

          {activeBatch && (
            <div className={`tp-batch is-${batchTone(activeBatch.status)}`} aria-live="polite">
              <div className="tp-batch-head">
                <span>
                  {activeBatch.status === "running" || activeBatch.status === "pending" ? (
                    <Loader2 size={13} className="tp-spin" aria-hidden="true" />
                  ) : (
                    <Check size={13} aria-hidden="true" />
                  )}{" "}
                  {t(`transfer.batch.${activeBatch.status}` as never, {
                    ok: activeBatch.ok,
                    failed: activeBatch.failed,
                    skipped: activeBatch.skipped,
                  })}
                </span>
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label={t("transfer.dismiss")}
                  onClick={() => useTransferStore.getState().dismissBatch()}
                >
                  <X size={12} />
                </button>
              </div>
              <div
                className="tp-progress"
                role="progressbar"
                aria-valuenow={batchProgress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={`${batchProgress}%`}
              >
                <span style={{ width: `${batchProgress}%` }} />
              </div>
              {activeBatch.message && <p className="tp-batch-msg">{activeBatch.message}</p>}
              {monitorState === "failed" && (
                <p className="tp-batch-msg tp-batch-alert" role="alert">
                  {t("transfer.monitor.failed", { error: monitorError ?? "" })}
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => useTransferStore.getState().retryBatchMonitor()}
                  >
                    {t("transfer.monitor.retry")}
                  </button>
                </p>
              )}
              <div className="tp-batch-actions">
                <button type="button" className="btn sm" onClick={() => setBatchDetailOpen(true)}>
                  {t("transfer.batchDetail")}
                </button>
                {activeBatch.failed > 0 && (
                  <button type="button" className="btn sm" onClick={() => void retryBatch()} disabled={busy}>
                    {t("transfer.retryFailed")}
                  </button>
                )}
                {(activeBatch.undoState === "available" || activeBatch.undoState === "partial") && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => void undoBatch()}
                    disabled={busy}
                    data-tip={activeBatch.undoReason}
                  >
                    {busy ? <Loader2 size={11} className="tp-spin" /> : null} {t("transfer.undo")}
                  </button>
                )}
              </div>
            </div>
          )}

          {error && <p className="tp-error">{error}</p>}
          {loading && visible.length === 0 ? (
            <div className="tp-empty">
              <Loader2 size={15} className="tp-spin" aria-hidden="true" /> {t("common.loading")}
            </div>
          ) : visible.length === 0 ? (
            <div className="tp-empty">
              <Archive size={20} aria-hidden="true" />
              <p>{t("transfer.emptyTray")}</p>
              <p className="tp-hint">{t("transfer.emptyTrayHint")}</p>
            </div>
          ) : (
            <ul
              className="tp-list"
              role="listbox"
              aria-multiselectable="true"
              aria-label={t("transfer.trayTab")}
              data-tip={t("transfer.dragHint")}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("text/plain") || dragIdRef.current) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => handleRowDrop(event, null)}
            >
              {visible.map((item) => (
                <li
                  key={item.id}
                  className={`tp-row${selection.includes(item.id) ? " is-selected" : ""}${
                    item.pinned ? " is-pinned" : ""
                  }${!item.available ? " is-unavailable" : ""}${dropTargetId === item.id ? " is-drop-target" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    dragIdRef.current = item.id;
                    event.dataTransfer.effectAllowed = "move";
                    // 只设内部协议：不要把条目 id 当作 text/plain 漏给外部应用。
                    event.dataTransfer.setData(TRAY_DRAG_MIME, item.id);
                  }}
                  onDragEnd={() => {
                    dragIdRef.current = null;
                    setDropTargetId(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (dropTargetId !== item.id) setDropTargetId(item.id);
                  }}
                  onDragLeave={() => setDropTargetId((current) => (current === item.id ? null : current))}
                  onDrop={(event) => {
                    event.stopPropagation();
                    handleRowDrop(event, item.id);
                  }}
                >
                  <input
                    type="checkbox"
                    className="tp-check"
                    checked={selection.includes(item.id)}
                    aria-label={item.title}
                    onChange={() => useTransferStore.getState().toggleSelection(item.id)}
                  />
                  <span className="tp-row-icon">{itemIcon(item.itemType)}</span>
                  <button
                    type="button"
                    className="tp-row-main tp-row-toggle"
                    aria-expanded={expandedId === item.id}
                    data-tip={t("transfer.previewHint")}
                    onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  >
                    <span className="tp-row-title" data-tip={item.title}>
                      {item.title || item.description || item.id}
                    </span>
                    <span className="tp-row-sub" data-tip={item.description}>
                      {!item.available && item.unavailableReason
                        ? `${t("transfer.status.expired")} · ${item.unavailableReason}`
                        : item.errorMessage || item.description || item.itemType}
                    </span>
                    {expandedId === item.id && (
                      <span className="tp-row-preview">
                        {previewText(item) || item.unavailableReason || t("transfer.noPreview")}
                      </span>
                    )}
                  </button>
                  <span className={`tp-status is-${item.status}`}>{t(`transfer.status.${item.status}` as never)}</span>
                  <button
                    type="button"
                    className="icon-btn sm"
                    aria-label={item.pinned ? t("transfer.unpin") : t("transfer.pin")}
                    onClick={() => void useTransferStore.getState().togglePin(item.id)}
                  >
                    {item.pinned ? <Pin size={12} /> : <PinOff size={12} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {visible.length < items.length && (
            <button type="button" className="tp-load-more" onClick={() => setLimit((n) => Math.min(200, n + 80))}>
              <ChevronDown size={13} aria-hidden="true" /> {t("transfer.loadMore")}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="tp-tools">
            <label className="tp-search">
              <Search size={13} aria-hidden="true" />
              <input
                value={clipQuery}
                placeholder={t("transfer.searchClipboard")}
                onChange={(event) => setClipQuery(event.target.value)}
              />
            </label>
            <div className="tp-selection-bar">
              <label className="tp-check-all">
                <input
                  type="checkbox"
                  checked={allClipSelected}
                  aria-label={t("transfer.selectAll")}
                  onChange={(event) =>
                    setClipSelected(event.target.checked ? clipItems.map((entry) => entry.id) : [])
                  }
                />
                {t("transfer.selectAll")}
              </label>
              <button
                type="button"
                className="tp-link"
                onClick={() =>
                  setClipSelected((current) => {
                    const selected = new Set(current);
                    return clipItems.map((entry) => entry.id).filter((id) => !selected.has(id));
                  })
                }
              >
                {t("transfer.selectInvert")}
              </button>
              <button type="button" className="tp-link" disabled={clipSelected.length === 0} onClick={() => setClipSelected([])}>
                {t("transfer.clearSelection")}
              </button>
            </div>
          </div>
          {clipError && <p className="tp-error">{clipError}</p>}
          {clipLoading ? (
            <div className="tp-empty">
              <Loader2 size={15} className="tp-spin" aria-hidden="true" /> {t("common.loading")}
            </div>
          ) : clipItems.length === 0 ? (
            <div className="tp-empty">
              <Type size={20} aria-hidden="true" />
              <p>{t("transfer.emptyClipboard")}</p>
            </div>
          ) : (
            <ul className="tp-list" role="listbox" aria-multiselectable="true" aria-label={t("transfer.clipboardTab")}>
              {clipItems.map((item) => (
                <li key={item.id} className={`tp-row${clipSelected.includes(item.id) ? " is-selected" : ""}`}>
                  <input
                    type="checkbox"
                    className="tp-check"
                    checked={clipSelected.includes(item.id)}
                    aria-label={item.title || item.preview || item.id}
                    onChange={() =>
                      setClipSelected((current) =>
                        current.includes(item.id)
                          ? current.filter((id) => id !== item.id)
                          : [...current, item.id],
                      )
                    }
                  />
                  <span className="tp-row-icon">{itemIcon(item.kind === "files" ? "file" : item.kind)}</span>
                  <div className="tp-row-main">
                    <span className="tp-row-title" data-tip={item.title}>
                      {item.title || item.preview || t("transfer.untitled")}
                    </span>
                    <span className="tp-row-sub">
                      {item.kind} · {new Date(item.created_at).toLocaleString()}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="tp-clip-actions">
            <button
              type="button"
              className="btn sm primary"
              disabled={clipSelected.length === 0}
              onClick={() => void addClipboardSelected()}
            >
              <Archive size={13} aria-hidden="true" /> {t("transfer.addSelected", { count: clipSelected.length })}
            </button>
          </div>
        </>
      )}

      <footer className="tp-foot">
        <TargetPicker
          value={target}
          onChange={handleTargetChange}
          onNotify={notify}
          onValidityChange={(valid, message) => {
            setTargetValid(valid);
            setTargetMessage(message);
          }}
        />
        <div className="tp-foot-actions">
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              const pane = useFilesWorkspaceStore.getState().panes[useFilesWorkspaceStore.getState().activePaneId];
              const dir = pane?.tabs.find((x) => x.tabId === pane.activeTabId)?.path;
              if (!dir) {
                notify(t("transfer.targetMissing"), "warning");
                return;
              }
              handleTargetChange(dir);
            }}
            data-tip={t("transfer.useFilesDirHint")}
          >
            {t("transfer.useFilesDir")}
          </button>
          <button type="button" className="btn sm" onClick={() => void removeSelected()} disabled={selectedCount === 0}>
            <Trash2 size={12} aria-hidden="true" /> {t("transfer.remove")}
          </button>
          <SendToMenu
            items={selectedItems}
            context={useTransferStore.getState().context}
            target={sendTarget}
            onNotify={notify}
            onSendToFiles={() => setPreviewOpen(true)}
            disabled={selectedCount === 0}
            label={t("transfer.sendMenu")}
            side="top"
            alignment="end"
            excludeActionIds={[ADD_TO_TRAY_ACTION]}
          />
          <button
            type="button"
            className="btn sm primary"
            onClick={() => setPreviewOpen(true)}
            disabled={selectedCount === 0 || !target || !targetValid || busy}
            data-tip={!targetValid && target ? targetMessage : undefined}
          >
            <Send size={12} aria-hidden="true" /> {t("transfer.sendToFiles")}
          </button>
        </div>
        {selectedCount === 0 && visible.length > 0 && <p className="tp-hint">{t("transfer.emptySelectionHint")}</p>}
      </footer>

      <TransferConfirmDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        ids={selection}
        target={sendTarget}
        options={sendOptions}
        onOptionsChange={setSendOptions}
        onNotify={notify}
        onExecuted={() => useTransferStore.getState().clearSelection()}
      />

      <Dialog
        open={reportOpen && addReport !== null}
        onClose={() => setReportOpen(false)}
        title={t("transfer.rejectedTitle")}
        size="sm"
        footer={
          <button type="button" className="btn" onClick={() => setReportOpen(false)}>
            {t("common.close")}
          </button>
        }
      >
        {addReport && (
          <div className="tp-report">
            <p className="tp-hint">{t("transfer.rejectedHint")}</p>
            <ul className="tp-preview-list">
              {rejectionLines(addReport.rejected).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {addReport.duplicates > 0 && (
              <p className="tp-hint">{t("transfer.duplicates", { count: addReport.duplicates })}</p>
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={batchDetailOpen && activeBatch !== null}
        onClose={() => setBatchDetailOpen(false)}
        title={t("transfer.batchDetail")}
        size="md"
        footer={
          <button type="button" className="btn" onClick={() => setBatchDetailOpen(false)}>
            {t("common.close")}
          </button>
        }
      >
        {activeBatch && (
          <div className="tp-report">
            <ul className="tp-batch-entries">
              {activeBatch.entries.map((entry, index) => (
                <li key={`${entry.itemId}-${index}`} className={`is-${entry.status}`}>
                  <span className="tp-batch-entry-label" data-tip={entry.label}>
                    {entry.label}
                  </span>
                  <span className={`tp-status is-${entry.status === "sent" ? "sent" : entry.status === "skipped" ? "expired" : "failed"}`}>
                    {entry.status === "sent"
                      ? t("transfer.status.sent")
                      : entry.status === "skipped"
                        ? t("transfer.optionSkip")
                        : t("transfer.status.failed")}
                  </span>
                  {entry.message && <span className="tp-batch-entry-msg">{entry.message}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Dialog>
    </aside>
  );
}
