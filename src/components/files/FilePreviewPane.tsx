//! 右侧文件检查器：预览 / 详细信息双视图 + 快捷操作 + 可拖拽宽度。
//!
//! 归属：整个文件工作区只有**一个**检查器实例（由 `FilesWorkspacePanel` 持有），
//! 不挂在每个 `FilePane` 上，避免 N 个窗格各建一套媒体播放器/PDF worker。
//!
//! 数据来源：
//! - 预览内容：`FilePreviewContent`（与弹窗共用同一套类型组件）；
//! - 元数据：先用 `FsEntry` 已有字段即时展示，详细信息页**按需**调用一次
//!   `fs_stat`（按路径缓存，最多 32 条），不在每次选择时批量拉取；
//! - 快捷操作：全部调用既有命令（`fs_open` / `fs_reveal` / 暂存架 / 固定目录），
//!   没有实现的「收藏」不渲染假按钮。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ClipboardCopy,
  ExternalLink,
  Eye,
  FolderSearch,
  Info,
  Pin,
  PinOff,
  Send,
  X,
} from "lucide-react";
import { fsOpen, fsReveal, fsStat, shelfAddPaths, type FsStat } from "../../lib/bridge";
import { useLocale } from "../../hooks/useLocale";
import { copyText } from "../../lib/clipboard";
import { errorMessage } from "../../lib/errors";
import { formatModified, formatSize } from "../../lib/filesWorkspace/fileMeta";
import {
  PREVIEW_PANE_DEFAULT_WIDTH,
  PREVIEW_PANE_MAX_WIDTH,
  PREVIEW_PANE_MIN_WIDTH,
} from "../../lib/filesWorkspace/persist";
import type {
  FilePreviewTarget,
  PreviewSelectionSummary,
} from "../../lib/filesWorkspace/previewSelection";
import { revisionKey, revisionOf } from "../../lib/filesWorkspace/previewRevision";
import type { MessageKey } from "../../locales/zh-CN";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import FileInfoHeader from "./preview/FileInfoHeader";
import FilePreviewContent from "./preview/FilePreviewContent";
import { useUiStore } from "../../store/useUiStore";

export interface FilePreviewPaneProps {
  target: FilePreviewTarget | null;
  summary: PreviewSelectionSummary;
  width: number;
  /** 弹窗打开期间挂起面板内容，避免同一文件出现两个播放器 / 两份 PDF 文档。 */
  suspended: boolean;
  /** 窄窗抽屉模式：不显示拖拽条，改为浮层。 */
  overlay?: boolean;
  pageActive: boolean;
  onClose: () => void;
  onCommitWidth: (width: number) => void;
  onNotice: (message: string, kind?: "info" | "success" | "error") => void;
}

const STAT_CACHE_LIMIT = 32;

/**
 * 详细信息缓存：**按路径 + 版本**（size / modifiedMs）缓存。
 * 同一路径被外部改写后版本变化 → 缓存键不同 → 重新 `fs_stat`，不会永久返回旧元数据。
 */
const statCache = new Map<string, FsStat>();

function statKey(target: FilePreviewTarget): string {
  return revisionKey(target.revision);
}

function readCachedStat(key: string): FsStat | null {
  const hit = statCache.get(key);
  if (!hit) return null;
  // 触碰即刷新 LRU 顺序。
  statCache.delete(key);
  statCache.set(key, hit);
  return hit;
}

function writeCachedStat(key: string, stat: FsStat): void {
  statCache.delete(key);
  statCache.set(key, stat);
  while (statCache.size > STAT_CACHE_LIMIT) {
    const oldest = statCache.keys().next().value;
    if (oldest === undefined) break;
    statCache.delete(oldest);
  }
}

/** 测试用：清空详细信息缓存（模块级缓存会跨用例共享）。 */
export function __resetPreviewStatCacheForTests(): void {
  statCache.clear();
}

const ATTRIBUTE_LABELS = {  readonly: "fw.props.attr.readonly",
  hidden: "fw.props.attr.hidden",
  system: "fw.props.attr.system",
  directory: "fw.props.attr.directory",
  archive: "fw.props.attr.archive",
  reparse: "fw.props.attr.reparse",
  compressed: "fw.props.attr.compressed",
  encrypted: "fw.props.attr.encrypted",
  offline: "fw.props.attr.offline",
  sparse: "fw.props.attr.sparse",
  temporary: "fw.props.attr.temporary",
  normal: "fw.props.attr.normal",
} as const;

type AttributeCode = keyof typeof ATTRIBUTE_LABELS;

function attributeLabel(code: string): MessageKey | null {
  if (code in ATTRIBUTE_LABELS) return ATTRIBUTE_LABELS[code as AttributeCode];
  return null;
}

/** 稳定 ID：工具栏按钮的 `aria-controls="fw-preview-pane"` 必须指向真实元素。 */
const PANE_ID = "fw-preview-pane";
const TAB_PREVIEW_ID = "fw-preview-tab-preview";
const TAB_DETAILS_ID = "fw-preview-tab-details";
const PANEL_PREVIEW_ID = "fw-preview-pane-panel-preview";
const PANEL_DETAILS_ID = "fw-preview-pane-panel-details";

export default function FilePreviewPane({
  target,
  summary,
  width,
  suspended,
  overlay = false,
  pageActive,
  onClose,
  onCommitWidth,
  onNotice,
}: FilePreviewPaneProps) {
  const { t } = useLocale();
  const showToast = useUiStore((state) => state.showToast);
  const pinnedDirs = useFilesWorkspaceStore((state) => state.pinnedDirs);
  const [tab, setTab] = useState<"preview" | "details">("preview");
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stat, setStat] = useState<FsStat | null>(null);
  const [statError, setStatError] = useState<string | null>(null);
  const [statAttempt, setStatAttempt] = useState(0);
  const sessionRef = useRef<{ pointerId: number; done: boolean; cleanup: (commit: boolean) => void } | null>(null);
  const previewTabRef = useRef<HTMLButtonElement>(null);
  const detailsTabRef = useRef<HTMLButtonElement>(null);

  const selectTab = (next: "preview" | "details", focus = false) => {
    setTab(next);
    if (focus) (next === "preview" ? previewTabRef : detailsTabRef).current?.focus();
  };

  /** WAI-ARIA Tabs Pattern 键盘：方向键循环、Home/End 跳转、Enter/Space 激活。 */
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = event.target as HTMLElement | null;
    const key = event.key;
    if (key === "ArrowRight" || key === "ArrowLeft") {
      event.preventDefault();
      selectTab(tab === "preview" ? "details" : "preview", true);
    } else if (key === "Home") {
      event.preventDefault();
      selectTab("preview", true);
    } else if (key === "End") {
      event.preventDefault();
      selectTab("details", true);
    } else if (key === "Enter" || key === " ") {
      if (current?.getAttribute("role") !== "tab") return;
      event.preventDefault();
      selectTab(current.id === TAB_DETAILS_ID ? "details" : "preview", true);
    }
  };

  const folder = summary.folder;
  const effectiveTarget: FilePreviewTarget | null = useMemo(
    () =>
      target ??
      (folder
        ? {
            paneId: "",
            path: folder.path,
            dir: "",
            name: folder.name,
            size: folder.entry.size,
            revision: revisionOf(folder.path, folder.entry),
            entry: folder.entry,
          }
        : null),
    [target, folder],
  );
  const hasContent = effectiveTarget !== null;
  const inactive = !pageActive;
  /**
   * 挂起 = 弹窗已接管该文件，或页面未激活（WorkbenchShell 是 keep 挂载，hidden 不等于卸载）。
   * 两者都必须卸载内容组件：媒体暂停并释放 token、PDF 取消渲染并销毁文档、图片吊销 Blob URL。
   * 不用 CSS `display:none` 假装停止，后台不存在仍在播放的媒体。
   */
  const contentSuspended = suspended || inactive;
  const effectiveWidth = draftWidth ?? width;

  // 切换文件/文件夹回到预览页（详情页不会停留在上一个文件）。
  useEffect(() => {
    setTab("preview");
  }, [effectiveTarget?.path]);

  // 详细信息：仅在该页可见时读取一次，失败保留重试入口。
  useEffect(() => {
    if (tab !== "details" || !effectiveTarget) {
      setStat(null);
      setStatError(null);
      return;
    }
    const cached = readCachedStat(statKey(effectiveTarget));
    if (cached) {
      setStat(cached);
      setStatError(null);
      return;
    }
    if (!pageActive) return;
    let cancelled = false;
    setStat(null);
    setStatError(null);
    const key = statKey(effectiveTarget);
    fsStat([effectiveTarget.path])
      .then(([result]) => {
        if (cancelled || !result) return;
        writeCachedStat(key, result);
        setStat(result);
      })
      .catch((cause) => {
        if (!cancelled) setStatError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [tab, effectiveTarget, pageActive, statAttempt]);

  const clampWidth = useCallback(
    (value: number) => Math.min(PREVIEW_PANE_MAX_WIDTH, Math.max(PREVIEW_PANE_MIN_WIDTH, Math.round(value))),
    [],
  );

  // 拖拽会话：pointermove 只改本地草稿，终止时提交一次（不每次写设置）。
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (sessionRef.current) return;
    event.preventDefault();
    const pane = (event.currentTarget.parentElement as HTMLElement | null)?.querySelector<HTMLElement>(
      ".fw-preview-pane",
    );
    const right = pane?.getBoundingClientRect().right ?? window.innerWidth;
    const pointerId = event.pointerId;
    let draft = clampWidth(width);
    const handle = event.currentTarget;

    const finish = (commit: boolean) => {
      const session = sessionRef.current;
      if (!session || session.done) return;
      session.done = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      document.body.classList.remove("ui-resizer-dragging");
      delete document.body.dataset.resizeAxis;
      handle.classList.remove("is-dragging");
      sessionRef.current = null;
      setDragging(false);
      setDraftWidth(null);
      if (commit) onCommitWidth(draft);
    };
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      draft = clampWidth(right - moveEvent.clientX);
      setDraftWidth(draft);
    };
    const onUp = (upEvent: globalThis.PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      finish(true);
    };
    const onCancel = (cancelEvent: globalThis.PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      finish(true);
    };
    const onBlur = () => finish(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") finish(true);
    };

    sessionRef.current = { pointerId, done: false, cleanup: finish };
    document.body.classList.add("ui-resizer-dragging");
    document.body.dataset.resizeAxis = "x";
    handle.classList.add("is-dragging");
    setDragging(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
  };

  // 卸载即结束拖拽会话：不提交未完成的宽度，清掉整窗拖拽态。
  useEffect(
    () => () => {
      sessionRef.current?.cleanup(false);
    },
    [],
  );

  const runAction = (action: () => Promise<unknown>) => {
    void action().catch((cause) => onNotice(errorMessage(cause), "error"));
  };

  const path = effectiveTarget?.path ?? "";
  const isDir = effectiveTarget?.entry.kind === "dir";
  const pinned = isDir && pinnedDirs.some((item) => item.toLowerCase() === path.toLowerCase());
  const detailRows: Array<{ label: string; value: string; mono?: boolean }> = effectiveTarget
    ? [
        { label: t("fw.inspector.name"), value: effectiveTarget.name },
        { label: t("fw.inspector.path"), value: effectiveTarget.path, mono: true },
        {
          label: t("fw.inspector.type"),
          value: isDir ? t("fw.inspector.kindFolder") : t("fw.inspector.kindFile"),
        },
        { label: t("fw.inspector.size"), value: formatSize(stat?.size ?? effectiveTarget.size) },
        { label: t("fw.inspector.ext"), value: effectiveTarget.name.split(".").pop() ?? "—" },
        { label: t("fw.inspector.created"), value: formatModified(stat?.createdMs ?? null) },
        { label: t("fw.inspector.modified"), value: formatModified(stat?.modifiedMs ?? effectiveTarget.entry.modifiedMs) },
        { label: t("fw.inspector.accessed"), value: formatModified(stat?.accessedMs ?? null) },
        {
          label: t("fw.props.attributes"),
          value:
            stat?.attributes && stat.attributes.length > 0
              ? stat.attributes
                  .map((code) => {
                    const label = attributeLabel(code);
                    return label ? t(label) : code;
                  })
                  .join(" · ")
              : t("fw.props.attributesEmpty"),
        },
        {
          label: t("fw.inspector.flags"),
          value: stat
            ? `${stat.readonly ? t("fw.props.attr.readonly") : t("fw.inspector.notReadonly")} · ${
                stat.hidden ? t("fw.props.attr.hidden") : t("fw.inspector.notHidden")
              }`
            : t("fw.inspector.pending"),
        },
        ...(isDir
          ? [
              {
                label: t("fw.inspector.children"),
                value:
                  stat?.childCount === null || stat?.childCount === undefined
                    ? t("fw.inspector.pending")
                    : t("fw.inspector.childCount", {
                        count: stat.childCount,
                        truncated: stat.childTruncated ? t("fw.inspector.childTruncated") : "",
                      }),
              },
            ]
          : []),
      ]
    : [];

  const body = (() => {
    if (contentSuspended) {
      return (
        <div className="fw-preview-pane-empty" role="status">
          <Eye size={20} aria-hidden="true" />
          <p>{inactive ? t("fw.inspector.inactive") : t("fw.inspector.suspended")}</p>
        </div>
      );
    }
    if (!hasContent) {
      if (summary.count > 1) {
        return (
          <div className="fw-preview-pane-empty" role="status">
            <Info size={20} aria-hidden="true" />
            <p className="fw-preview-pane-empty-title">{t("fw.inspector.multiTitle", { count: summary.count })}</p>
            <p>
              {t("fw.inspector.multiBody", {
                files: summary.files,
                dirs: summary.dirs,
                size: formatSize(summary.bytes),
              })}
            </p>
            <p className="fw-preview-pane-empty-hint">{t("fw.inspector.multiHint")}</p>
          </div>
        );
      }
      if (summary.count === 1) {
        return (
          <div className="fw-preview-pane-empty" role="status">
            <Info size={20} aria-hidden="true" />
            <p>{t("fw.inspector.filteredOut")}</p>
          </div>
        );
      }
      return (
        <div className="fw-preview-pane-empty" role="status">
          <Eye size={20} aria-hidden="true" />
          <p>{t("fw.inspector.empty")}</p>
          <p className="fw-preview-pane-empty-hint">{t("fw.inspector.emptyHint")}</p>
        </div>
      );
    }
    /**
     * 两个 TabPanel 始终存在，`hidden` 只隐藏非活动页；活动页之外的重型内容不挂载，
     * 因此保留 ARIA 关系不会重新引入后台播放器 / PDF Worker。
     */
    return (
      <>
        <div
          className="fw-preview-pane-preview"
          id={PANEL_PREVIEW_ID}
          role="tabpanel"
          aria-labelledby={TAB_PREVIEW_ID}
          hidden={tab !== "preview"}
          style={tab === "preview" ? undefined : { display: "none" }}
        >
          {tab === "preview" ? (
            <FilePreviewContent
              target={effectiveTarget}
              variant="panel"
              onNotice={(message) => {
                if (message) onNotice(message, "error");
              }}
            />
          ) : null}
        </div>
        <div
          className="fw-preview-pane-details"
          id={PANEL_DETAILS_ID}
          role="tabpanel"
          aria-labelledby={TAB_DETAILS_ID}
          hidden={tab !== "details"}
          style={tab === "details" ? undefined : { display: "none" }}
        >
          {tab === "details" ? (
            <>
              {statError ? (
                <div className="fw-preview-pane-details-error" role="alert">
                  <p>{t("fw.inspector.statFailed", { error: statError })}</p>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setStatError(null);
                      setStatAttempt((value) => value + 1);
                    }}
                  >
                    {t("common.retry")}
                  </button>
                </div>
              ) : null}
              <dl className="fw-preview-pane-detail-list">
                {detailRows.map((row) => (
                  <div key={row.label} className="fw-preview-pane-detail-row">
                    <dt>{row.label}</dt>
                    <dd className={row.mono ? "is-mono" : undefined} title={row.value}>
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
              {!stat && !statError ? <p className="fw-preview-pane-detail-note">{t("fw.inspector.statLoading")}</p> : null}
            </>
          ) : null}
        </div>
      </>
    );
  })();

  return (
    <>
      {!overlay && (
        <div
          className="fw-preview-resizer ui-resizer ui-resizer--edge-end"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("fw.inspector.resizeAria")}
          aria-valuemin={PREVIEW_PANE_MIN_WIDTH}
          aria-valuemax={PREVIEW_PANE_MAX_WIDTH}
          aria-valuenow={effectiveWidth}
          tabIndex={0}
          data-dragging={dragging ? "true" : undefined}
          onPointerDown={beginResize}
          onDoubleClick={(event) => {
            event.preventDefault();
            onCommitWidth(PREVIEW_PANE_DEFAULT_WIDTH);
          }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 40 : 16;
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              onCommitWidth(clampWidth(effectiveWidth - step));
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              onCommitWidth(clampWidth(effectiveWidth + step));
            } else if (event.key === "Home") {
              event.preventDefault();
              onCommitWidth(PREVIEW_PANE_MIN_WIDTH);
            } else if (event.key === "End") {
              event.preventDefault();
              onCommitWidth(PREVIEW_PANE_MAX_WIDTH);
            } else if (event.key === "Enter") {
              event.preventDefault();
              onCommitWidth(PREVIEW_PANE_DEFAULT_WIDTH);
            }
          }}
        />
      )}
      <aside
        id={PANE_ID}
        className={`fw-preview-pane${overlay ? " is-overlay" : ""}`}
        style={{ width: overlay ? undefined : effectiveWidth }}
        aria-label={t("fw.inspector.aria")}
        data-open="true"
        data-active={contentSuspended ? "false" : "true"}
      >
        <header className="fw-preview-pane-head">
          <div className="fw-preview-pane-head-main">
            {effectiveTarget ? (
              <FileInfoHeader
                entry={effectiveTarget.entry}
                path={effectiveTarget.path}
                variant="panel"
              />
            ) : (
              <>
                <span className="fw-preview-pane-title">{t("fw.inspector.title")}</span>
                <span className="fw-preview-pane-subtitle">{t("fw.inspector.subtitle")}</span>
              </>
            )}
          </div>
          <button
            type="button"
            className="icon-btn sm"
            aria-label={t("fw.inspector.close")}
            data-tip={t("fw.inspector.close")}
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        {hasContent && !contentSuspended && (
          <div
            className="fw-preview-pane-tabs"
            role="tablist"
            aria-label={t("fw.inspector.tabsAria")}
            onKeyDown={onTabKeyDown}
          >
            <button
              type="button"
              role="tab"
              id={TAB_PREVIEW_ID}
              ref={previewTabRef}
              aria-selected={tab === "preview"}
              aria-controls={PANEL_PREVIEW_ID}
              tabIndex={tab === "preview" ? 0 : -1}
              className={`fw-preview-pane-tab${tab === "preview" ? " is-active" : ""}`}
              onClick={() => selectTab("preview")}
            >
              {t("fw.inspector.tabPreview")}
            </button>
            <button
              type="button"
              role="tab"
              id={TAB_DETAILS_ID}
              ref={detailsTabRef}
              aria-selected={tab === "details"}
              aria-controls={PANEL_DETAILS_ID}
              tabIndex={tab === "details" ? 0 : -1}
              className={`fw-preview-pane-tab${tab === "details" ? " is-active" : ""}`}
              onClick={() => selectTab("details")}
            >
              {t("fw.inspector.tabDetails")}
            </button>
          </div>
        )}

        <div className="fw-preview-pane-body">{body}</div>

        {hasContent && (
          <footer className="fw-preview-pane-actions">
            <button
              type="button"
              className="btn sm"
              onClick={() => runAction(() => fsOpen(path))}
              data-tip={t("fw.inspector.open")}
            >
              <ExternalLink size={12} aria-hidden="true" />
              {t("fw.inspector.open")}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => runAction(() => fsReveal(path))}
              data-tip={t("fw.inspector.reveal")}
            >
              <FolderSearch size={12} aria-hidden="true" />
              {t("fw.inspector.reveal")}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                runAction(async () => {
                  const ok = await copyText(path);
                  onNotice(ok ? t("fw.inspector.pathCopied") : t("fw.inspector.pathCopyFailed"), ok ? "success" : "error");
                })
              }
              data-tip={t("fw.inspector.copyPath")}
            >
              <ClipboardCopy size={12} aria-hidden="true" />
              {t("fw.inspector.copyPath")}
            </button>
            {isDir ? (
              <button
                type="button"
                className="btn sm"
                aria-pressed={pinned}
                onClick={() => useFilesWorkspaceStore.getState().togglePinnedDir(path)}
                data-tip={pinned ? t("fw.inspector.unpin") : t("fw.inspector.pin")}
              >
                {pinned ? <PinOff size={12} aria-hidden="true" /> : <Pin size={12} aria-hidden="true" />}
                {pinned ? t("fw.inspector.unpin") : t("fw.inspector.pin")}
              </button>
            ) : (
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  runAction(async () => {
                    const result = await shelfAddPaths([path], "reference", "manual", null);
                    showToast(t("fw.report.toShelf", { count: result.added.length }), { kind: "success" });
                  })
                }
                data-tip={t("fw.inspector.toShelf")}
              >
                <Send size={12} aria-hidden="true" />
                {t("fw.inspector.toShelf")}
              </button>
            )}
          </footer>
        )}
      </aside>
    </>
  );
}
