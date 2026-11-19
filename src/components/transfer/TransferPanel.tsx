//! 全局工作篮面板（工作台固定列 / 主窗口与窄窗抽屉共用）。
//!
//! 只做展示与交互编排：条目读写走 `useTransferStore`，发送前预览与执行走后端
//! `transfer_preview` / `transfer_execute`，不在组件里复制任何文件操作逻辑。

import { useEffect, useMemo, useRef, useState } from "react";
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
import Select from "../ui/Select";
import { useOverlayLayer } from "../ui/overlay";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { useTransferStore } from "../../store/useTransferStore";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import { addClipboardItemsToTray } from "../../lib/crossTab/modules/clipboard";
import { CREATE_TASK_ACTION_ID } from "../../lib/crossTab/modules/tasks";
import { executeAction, getAction } from "../../lib/crossTab/actionRegistry";
import * as client from "../../lib/crossTab/transferClient";
import { TRANSFER_EVENTS, subscribe } from "../../lib/crossTab/eventBus";
import type { TransferOptions, TransferPreview, TransferTarget } from "../../lib/crossTab/types";
import { pickFolder } from "../../lib/filesWorkspace/folderPicker";
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

interface TransferPanelProps {
  variant: "dock" | "drawer";
  onClose: () => void;
}

export default function TransferPanel({ variant, onClose }: TransferPanelProps) {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const items = useTransferStore((s) => s.items);
  const total = useTransferStore((s) => s.total);
  const selection = useTransferStore((s) => s.selection);
  const filter = useTransferStore((s) => s.filter);
  const panel = useTransferStore((s) => s.panel);
  const context = useTransferStore((s) => s.context);
  const activeBatch = useTransferStore((s) => s.activeBatch);
  const busy = useTransferStore((s) => s.busy);
  const loading = useTransferStore((s) => s.loading);
  const error = useTransferStore((s) => s.error);

  const [tab, setTab] = useState<"tray" | "clipboard">("tray");
  const [target, setTarget] = useState(readTarget);
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [sendOptions, setSendOptions] = useState<TransferOptions>(client.DEFAULT_OPTIONS);
  const panelRef = useRef<HTMLElement>(null);
  const [clipItems, setClipItems] = useState<ClipboardItem[]>([]);
  const [clipSelected, setClipSelected] = useState<string[]>([]);
  const [clipQuery, setClipQuery] = useState("");
  const [clipLoading, setClipLoading] = useState(false);
  const [clipError, setClipError] = useState("");
  const [limit, setLimit] = useState(80);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filesPanes = useFilesWorkspaceStore((s) => s.panes);
  const filesActivePaneId = useFilesWorkspaceStore((s) => s.activePaneId);
  const filesSelectionMap = useFilesWorkspaceStore((s) => s.selection);
  const filesSelection = useMemo(
    () =>
      filesPanes[filesActivePaneId]
        ? (filesSelectionMap[filesActivePaneId]?.paths ?? [])
        : [],
    [filesPanes, filesActivePaneId, filesSelectionMap],
  );

  // 抽屉形态注册到统一弹层栈：Escape 只关工作篮，不直接隐藏窗口。
  useOverlayLayer("drawer", variant === "drawer", onClose, panelRef);

  useEffect(() => {
    void useTransferStore.getState().refresh();
    void client.getContext().then((next) => {
      useTransferStore.getState().setContext(next);
      if (!readTarget() && next.directory) {
        setTarget(next.directory);
        writeTarget(next.directory);
      }
    });
    const unsubContext = subscribe(
      TRANSFER_EVENTS.contextChanged,
      (payload) => {
        useTransferStore.getState().setContext(payload as typeof context);
      },
      "transfer-panel",
    );
    const unsubBatch = subscribe(
      TRANSFER_EVENTS.batchChanged,
      () => {
        void useTransferStore.getState().refresh();
      },
      "transfer-panel",
    );
    return () => {
      unsubContext();
      unsubBatch();
    };
  }, []);

  useEffect(() => {
    if (tab !== "clipboard") return;
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
  }, [tab, clipQuery]);

  const visible = useMemo(() => {
    const rows = items.filter((item) => item.status !== "sent" || item.pinned);
    return rows.slice(0, limit);
  }, [items, limit]);

  const selectedCount = selection.length;
  const allVisibleSelected = visible.length > 0 && visible.every((item) => selection.includes(item.id));

  function toggleType(id: string) {
    const filterDef = TYPE_FILTERS.find((entry) => entry.id === id);
    if (!filterDef) return;
    useTransferStore.getState().setItemTypes(filterDef.types);
  }

  const selectedTextItems = useMemo(
    () => items.filter((item) => selection.includes(item.id) && item.content.trim().length > 0),
    [items, selection],
  );

  const taskAction = getAction(CREATE_TASK_ACTION_ID);
  const canCreateTask = Boolean(
    taskAction &&
      selectedCount > 0 &&
      items
        .filter((item) => selection.includes(item.id))
        .every((item) => taskAction.supportedItemTypes.includes(item.itemType)),
  );

  async function createTaskFromSelection() {
    const action = getAction(CREATE_TASK_ACTION_ID);
    if (!action) {
      showToast(t("transfer.actionUnavailable"), { kind: "warning" });
      return;
    }
    const selectedItems = items.filter((item) => selection.includes(item.id));
    const result = await executeAction(CREATE_TASK_ACTION_ID, {
      items: selectedItems,
      context: useTransferStore.getState().context,
    });
    showToast(result.message, { kind: result.ok ? "success" : "error" });
    if (result.ok) useTransferStore.getState().clearSelection();
  }

  async function copySelectedText() {
    if (selectedTextItems.length === 0) return;
    const ok = await copyText(selectedTextItems.map((item) => item.content).join("\n\n"));
    showToast(ok ? t("transfer.copied", { count: selectedTextItems.length }) : t("transfer.copyFailed"), {
      kind: ok ? "success" : "error",
    });
  }

  async function addFilesSelection() {
    if (filesSelection.length === 0) return;
    try {
      const report = await useTransferStore.getState().add(
        filesSelection.map((path) => ({
          itemType: "file",
          sourceModule: "files",
          sourceId: path,
          title: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
          description: path,
          payload: { path },
        })),
      );
      showToast(t("transfer.added", { count: report.added }), { kind: "success" });
      if (report.duplicates > 0) {
        showToast(t("transfer.duplicates", { count: report.duplicates }), { kind: "info" });
      }
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  }

  async function addClipboardSelected() {
    if (clipSelected.length === 0) return;
    try {
      const { report, failed } = await addClipboardItemsToTray(clipSelected);
      if (report) {
        showToast(t("transfer.added", { count: report.items.length }), { kind: "success" });
        if (report.duplicates > 0) {
          showToast(t("transfer.duplicates", { count: report.duplicates }), { kind: "info" });
        }
      }
      if (failed.length > 0) {
        showToast(t("transfer.addFailed", { count: failed.length }), { kind: "warning" });
      }
      await useTransferStore.getState().refresh();
      setClipSelected([]);
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  }

  async function chooseTarget() {
    const result = await pickFolder({ title: t("transfer.chooseTarget") });
    if (result.status === "ok") {
      setTarget(result.path);
      writeTarget(result.path);
      void client.updateContext({ directory: result.path });
    } else if (result.status === "invalid") {
      showToast(`${t("transfer.targetInvalid")} ${result.message ?? result.reason}`, { kind: "error" });
    }
  }

  async function useFilesWorkspaceDir() {
    const pane = useFilesWorkspaceStore.getState().panes[useFilesWorkspaceStore.getState().activePaneId];
    const dir = pane?.tabs.find((x) => x.tabId === pane.activeTabId)?.path;
    if (!dir) {
      showToast(t("transfer.targetMissing"), { kind: "warning" });
      return;
    }
    setTarget(dir);
    writeTarget(dir);
    void client.updateContext({ directory: dir });
  }

  async function openPreview(options: TransferOptions = sendOptions) {
    if (selectedCount === 0) return;
    if (!target.trim()) {
      showToast(t("transfer.targetRequired"), { kind: "warning" });
      return;
    }
    setPreviewing(true);
    setPreviewError("");
    try {
      const validation = await client.validateTarget({ module: "files", ref: target });
      if (!validation.valid) {
        setPreview(null);
        setPreviewError(validation.message || t("transfer.targetInvalid"));
        setPreviewOpen(true);
        return;
      }
      const result = await client.previewTransfer(
        selection,
        { module: "files", ref: target },
        options,
      );
      setPreview(result);
      setPreviewOpen(true);
    } catch (e) {
      setPreview(null);
      setPreviewError(errorMessage(e));
      setPreviewOpen(true);
    } finally {
      setPreviewing(false);
    }
  }

  async function confirmSend() {
    if (!preview || !preview.targetValid) return;
    const targetRef: TransferTarget = { module: "files", ref: preview.targetRef };
    setPreviewOpen(false);
    try {
      const batch = await useTransferStore.getState().send(selection, targetRef, sendOptions);
      showToast(t("transfer.started", { count: batch.total }), { kind: "success" });
      useTransferStore.getState().clearSelection();
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  }

  async function removeSelected() {
    if (selectedCount === 0) return;
    try {
      const removed = await useTransferStore.getState().remove(selection);
      showToast(t("transfer.removed", { count: removed }), { kind: "success" });
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  }

  async function clearTemporary() {
    try {
      const removed = await useTransferStore.getState().clearTemporary();
      showToast(t("transfer.cleared", { count: removed }), { kind: "success" });
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  }

  async function retryBatch() {
    try {
      const next = await useTransferStore.getState().retry();
      if (next) showToast(t("transfer.retried"), { kind: "success" });
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  }

  async function undoBatch() {
    if (!activeBatch) return;
    try {
      const result = await useTransferStore.getState().undo(activeBatch.id);
      showToast(result.message, { kind: result.moved > 0 ? "success" : "warning" });
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  }

  function patchOptions(patch: Partial<TransferOptions>) {
    setSendOptions((prev) => ({ ...prev, ...patch }));
  }

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

  const batchDone = activeBatch ? activeBatch.ok + activeBatch.failed + activeBatch.skipped : 0;  const batchProgress = activeBatch && activeBatch.total > 0
    ? Math.round((batchDone / activeBatch.total) * 100)
    : 0;

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
            data-tip={t("transfer.pinPanelHint")}
            onClick={() => useTransferStore.getState().togglePinnedPanel()}
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
          </div>

          {activeBatch && (
            <div className={`tp-batch is-${batchTone(activeBatch.status)}`} aria-live="polite">
              <div className="tp-batch-head">
                <span>
                  {activeBatch.status === "running" ? (
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
              <div className="tp-progress" role="progressbar" aria-valuenow={batchProgress} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${batchProgress}%` }} />
              </div>
              {activeBatch.message && <p className="tp-batch-msg">{activeBatch.message}</p>}
              <div className="tp-batch-actions">
                {activeBatch.failed > 0 && (
                  <button type="button" className="btn sm" onClick={() => void retryBatch()} disabled={busy}>
                    {t("transfer.retryFailed")}
                  </button>
                )}
                {(activeBatch.undoState === "available" || activeBatch.undoState === "partial") && (
                  <button type="button" className="btn sm" onClick={() => void undoBatch()} data-tip={activeBatch.undoReason}>
                    {t("transfer.undo")}
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
            <ul className="tp-list" role="listbox" aria-multiselectable="true" aria-label={t("transfer.trayTab")}>
              {visible.map((item) => (
                <li
                  key={item.id}
                  className={`tp-row${selection.includes(item.id) ? " is-selected" : ""}${item.pinned ? " is-pinned" : ""}${!item.available ? " is-unavailable" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      "application/x-taskdock-transfer",
                      JSON.stringify({ itemIds: [item.id], source: "tray" }),
                    );
                    event.dataTransfer.effectAllowed = "copy";
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
                    <span className="tp-row-title" data-tip={item.title}>{item.title || item.description || item.id}</span>
                    <span className="tp-row-sub" data-tip={item.description}>
                      {item.errorMessage || item.description || item.itemType}
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
        <div className="tp-target">
          <span className="tp-target-label">{t("transfer.target")}</span>
          <button
            type="button"
            className={`tp-target-value${target ? "" : " is-empty"}`}
            data-tip={target || t("transfer.targetNone")}
            onClick={() => void chooseTarget()}
          >
            <Folder size={12} aria-hidden="true" />
            <span className="tp-ellipsis">{target || t("transfer.targetNone")}</span>
          </button>
        </div>
        <div className="tp-foot-actions">
          <button type="button" className="btn sm" onClick={() => void useFilesWorkspaceDir()} data-tip={t("transfer.useFilesDirHint")}>
            {t("transfer.useFilesDir")}
          </button>
          <button type="button" className="btn sm" onClick={() => void removeSelected()} disabled={selectedCount === 0}>
            <Trash2 size={12} aria-hidden="true" /> {t("transfer.remove")}
          </button>
          <button
            type="button"
            className="btn sm primary"
            onClick={() => void openPreview()}
            disabled={selectedCount === 0 || !target || busy || previewing}
          >
            {previewing ? <Loader2 size={12} className="tp-spin" /> : <Send size={12} aria-hidden="true" />}{" "}
            {t("transfer.sendToFiles")}
          </button>
        </div>
        {selectedCount > 0 && (
          <div className="tp-select-all">
            <label>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={(event) =>
                  event.target.checked
                    ? useTransferStore.getState().selectAllVisible()
                    : useTransferStore.getState().clearSelection()
                }
              />{" "}
              {t("transfer.selectAll")}
            </label>
            <button type="button" className="tp-link" onClick={() => useTransferStore.getState().clearSelection()}>
              {t("transfer.clearSelection")}
            </button>
          </div>
        )}
        <input type="hidden" value={target} readOnly />
      </footer>

      <Dialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t("transfer.previewTitle")}
        size="md"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setPreviewOpen(false)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={previewing || !preview}
              onClick={() => void openPreview(sendOptions)}
            >
              {t("transfer.repreview")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!preview?.targetValid || previewing}
              onClick={() => void confirmSend()}
            >
              {t("transfer.confirmSend")}
            </button>
          </>
        }
      >
        {previewError ? (
          <p className="tp-error">{previewError}</p>
        ) : preview ? (
          <div className="tp-preview">
            <p className="tp-preview-target">
              {t("transfer.previewTarget")} <code>{preview.targetRef}</code>
            </p>
            <div className="tp-preview-options">
              <label>
                <span>{t("transfer.optionTextFormat")}</span>
                <Select
                  value={sendOptions.textFormat}
                  options={[
                    { value: "txt", label: t("transfer.optionTxt") },
                    { value: "md", label: t("transfer.optionMarkdown") },
                  ]}
                  onChange={(value) => patchOptions({ textFormat: value as TransferOptions["textFormat"] })}
                  ariaLabel={t("transfer.optionTextFormat")}
                  block
                  size="sm"
                />
              </label>
              <label>
                <span>{t("transfer.optionTextMode")}</span>
                <Select
                  value={sendOptions.textMode}
                  options={[
                    { value: "separate", label: t("transfer.optionSeparate") },
                    { value: "merge", label: t("transfer.optionMerge") },
                  ]}
                  onChange={(value) => patchOptions({ textMode: value as TransferOptions["textMode"] })}
                  ariaLabel={t("transfer.optionTextMode")}
                  block
                  size="sm"
                />
              </label>
              <label>
                <span>{t("transfer.optionFileOperation")}</span>
                <Select
                  value={sendOptions.fileOperation}
                  options={[
                    { value: "copy", label: t("transfer.optionCopy") },
                    { value: "move", label: t("transfer.optionMove") },
                  ]}
                  onChange={(value) => patchOptions({ fileOperation: value as TransferOptions["fileOperation"] })}
                  ariaLabel={t("transfer.optionFileOperation")}
                  block
                  size="sm"
                />
              </label>
              <label>
                <span>{t("transfer.optionUrlMode")}</span>
                <Select
                  value={sendOptions.urlMode}
                  options={[
                    { value: "url", label: t("transfer.optionUrlFile") },
                    { value: "markdown", label: t("transfer.optionUrlMarkdown") },
                  ]}
                  onChange={(value) => patchOptions({ urlMode: value as TransferOptions["urlMode"] })}
                  ariaLabel={t("transfer.optionUrlMode")}
                  block
                  size="sm"
                />
              </label>
              <label>
                <span>{t("transfer.optionConflict")}</span>
                <Select
                  value={sendOptions.conflict}
                  options={[
                    { value: "rename", label: t("transfer.optionRename") },
                    { value: "skip", label: t("transfer.optionSkip") },
                    { value: "overwrite", label: t("transfer.optionOverwrite") },
                  ]}
                  onChange={(value) => patchOptions({ conflict: value as TransferOptions["conflict"] })}
                  ariaLabel={t("transfer.optionConflict")}
                  block
                  size="sm"
                />
              </label>
            </div>
            <p className="tp-preview-hint">{t("transfer.repreviewHint")}</p>
            <div className="tp-preview-grid">
              <span>{t("transfer.previewText")}<b>{preview.counts.text + preview.counts.richtext}</b></span>
              <span>{t("transfer.previewImage")}<b>{preview.counts.image}</b></span>
              <span>{t("transfer.previewFile")}<b>{preview.counts.file + preview.counts.directory}</b></span>
              <span>{t("transfer.previewUrl")}<b>{preview.counts.url}</b></span>
              <span>{t("transfer.previewFiles")}<b>{preview.plannedFiles}</b></span>
              <span>{t("transfer.previewUnsupported")}<b>{preview.counts.unsupported}</b></span>
            </div>
            {preview.conflicts.length > 0 && (
              <p className="tp-preview-warn">
                {t("transfer.previewConflicts", { count: preview.conflicts.length })}
              </p>
            )}
            {preview.unsupported.length > 0 && (
              <ul className="tp-preview-list">
                {preview.unsupported.slice(0, 5).map((entry) => (
                  <li key={entry.itemId}>{entry.title}：{entry.reason}</li>
                ))}
              </ul>
            )}
            {preview.warnings.map((warning) => (
              <p key={warning} className="tp-preview-warn">{warning}</p>
            ))}
          </div>
        ) : null}
      </Dialog>
    </aside>
  );
}
