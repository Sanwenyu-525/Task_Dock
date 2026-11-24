//! 快速预览弹窗：文件信息头部 + 内容（含类型工具栏）+ 底部导航。
//!
//! 唯一入口与唯一容器：类型判定交给 `preview/previewKind`，内容渲染统一交给
//! `preview/FilePreviewContent`（与右侧检查器共用同一套预览组件），
//! 这里只负责 Dialog 外壳、同目录文件切换、键盘与生命周期。
//!
//! 资源释放：媒体 token 由各媒体组件经同一 tracker 语义释放，图片 Blob URL /
//! PDF 文档在组件卸载时释放；本容器不持有第二套释放机制。
//! 预览内容用 `key={currentPath}` 挂载：切换文件即卸载旧实例，杜绝「旧内容闪回」
//! 与「两个播放器同时存在」。

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useLocale } from "../../hooks/useLocale";
import { fsOpen, fsStat, type FsEntry } from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { getDirState, subscribeDir, type DirState } from "../../lib/filesWorkspace/dirCache";
import { joinPath } from "../../lib/filesWorkspace/pathUtils";
import { revisionKey, revisionOf, type PreviewRevision } from "../../lib/filesWorkspace/previewRevision";
import { useUiStore } from "../../store/useUiStore";
import FileInfoHeader from "./preview/FileInfoHeader";
import FilePreviewContent from "./preview/FilePreviewContent";
import { PreviewUnsupported } from "./preview/PreviewState";
import { getPreviewKind } from "./preview/previewKind";

export { createPreviewTokenTracker, type PreviewTokenTracker } from "./preview/mediaToken";

export interface PreviewRequest {
  paneId: string;
  path: string;
  dir: string;
  entries: FsEntry[];
}

interface Props {
  request: PreviewRequest | null;
  onClose: () => void;
}

/** 键盘事件是否应归输入控件/媒体控件自己处理（预览不抢这些按键）。 */
function ownsKey(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest("video, audio, [role='slider']"));
}

export default function QuickPreviewDialog({ request, onClose }: Props) {
  const { t } = useLocale();
  const showToast = useUiStore((state) => state.showToast);
  /**
   * 导航索引与请求身份绑定：请求变化后**首次渲染**就用新请求的目标文件，
   * 不再先读旧 index 再靠 effect 修正（否则会短暂挂载错误文件）。
   */
  const [nav, setNav] = useState<{ key: string; index: number }>({ key: "", index: 0 });
  /** 目录事件带来的最新条目，只用于检测版本变化，不自动替换当前内容。 */
  const [live, setLive] = useState<{ listing: FsEntry[]; fetchedAt: number } | null>(null);
  /** 用户在弹窗内显式刷新后采用的版本（按小写路径索引）。 */
  const [overrides, setOverrides] = useState<Record<string, PreviewRevision>>({});
  const [refreshing, setRefreshing] = useState(false);
  /** 同一路径的同一 IPC 错误短时间重复点击只提示一次（不吞异常、不关闭弹窗）。 */
  const lastOpenError = useRef<{ key: string; at: number } | null>(null);

  // 只在当前目录的**文件**之间切换：文件夹不进预览列表（与文件管理器一致）。
  const files = useMemo(
    () => (request ? request.entries.filter((entry) => entry.kind !== "dir") : []),
    [request],
  );
  const requestKey = request
    ? (() => {
        const targetEntry = request.entries.find((entry) => joinPath(request.dir, entry.name) === request.path);
        return [
          request.paneId,
          request.dir,
          request.path,
          request.entries.length,
          targetEntry?.size ?? "-",
          targetEntry?.modifiedMs ?? "-",
        ].join("\u0000");
      })()
    : "";
  const foundIndex = request ? files.findIndex((entry) => joinPath(request.dir, entry.name) === request.path) : -1;
  const index = nav.key === requestKey ? Math.min(Math.max(nav.index, 0), Math.max(files.length - 1, 0)) : Math.max(foundIndex, 0);
  const selectIndex = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), Math.max(files.length - 1, 0));
    setNav({ key: requestKey, index: clamped });
  };

  const current = files[index] ?? null;
  const kind = getPreviewKind(current);
  const currentPath = current && request ? joinPath(request.dir, current.name) : request?.path ?? "";

  // 订阅当前目录：目录事件/刷新只更新「最新条目」，用于版本提示；不自动重载内容。
  useEffect(() => {
    if (!request?.dir) return;
    let alive = true;
    const accept = (state: DirState) => {
      if (!alive || !state.listing) return;
      const listing = state.listing;
      const fetchedAt = state.fetchedAt;
      setLive((prev) => (!prev || fetchedAt >= prev.fetchedAt ? { listing, fetchedAt } : prev));
    };
    const unsubscribers = [subscribeDir(request.dir, false, accept), subscribeDir(request.dir, true, accept)];
    for (const hidden of [false, true]) {
      const state = getDirState(request.dir, hidden);
      if (state.listing) accept(state);
    }
    return () => {
      alive = false;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [request?.dir]);

  // 新请求（重新打开/换文件）丢弃上一轮的刷新结果与目录观察。
  useEffect(() => {
    setOverrides({});
    setLive(null);
  }, [requestKey]);

  const baseRevision = current && request ? revisionOf(currentPath, current) : null;
  const override = current ? overrides[currentPath.toLowerCase()] : undefined;
  const effectiveRevision = override ?? baseRevision;
  const liveEntry = current
    ? live?.listing.find((entry) => entry.name.toLowerCase() === current.name.toLowerCase()) ?? null
    : null;
  /**
   * 版本语义：弹窗打开期间内容保持稳定；检测到同路径新版本时只提示，
   * 用户点击刷新才换 revision（换 revision 会重建内容并释放旧媒体/PDF 资源）。
   */
  const stale =
    !!current &&
    !!liveEntry &&
    !!effectiveRevision &&
    revisionKey(revisionOf(currentPath, liveEntry)) !== revisionKey(effectiveRevision);

  const effectiveEntry = current && override
    ? { ...current, size: override.size ?? current.size, modifiedMs: override.modifiedMs ?? current.modifiedMs }
    : current;

  const refreshCurrent = async () => {
    if (!currentPath || refreshing) return;
    setRefreshing(true);
    try {
      const [fresh] = await fsStat([currentPath]);
      if (!fresh || !fresh.exists) {
        showToast(t("fw.preview.refreshMissing"), { kind: "error" });
        return;
      }
      const revision: PreviewRevision = { path: currentPath, size: fresh.size, modifiedMs: fresh.modifiedMs };
      setOverrides((prev) => ({ ...prev, [currentPath.toLowerCase()]: revision }));
    } catch (cause) {
      showToast(t("fw.preview.refreshFailed", { error: errorMessage(cause) }), { kind: "error" });
    } finally {
      setRefreshing(false);
    }
  };

  // Escape 由全局弹层栈（Dialog）关闭；这里只处理左右切换，且不消费输入控件按键。
  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (ownsKey(event.target)) return;
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        selectIndex(index - 1);
      } else if (event.key === "ArrowRight" && index < files.length - 1) {
        event.preventDefault();
        selectIndex(index + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, index, files.length]);

  if (!request) return null;

  const title = current?.name ?? request.path.split(/[\\/]/).pop() ?? "";
  const target =
    current && effectiveEntry && effectiveRevision && kind !== "unsupported"
      ? {
          paneId: request.paneId,
          path: currentPath,
          dir: request.dir,
          name: effectiveEntry.name,
          size: effectiveEntry.size,
          revision: effectiveRevision,
          entry: effectiveEntry,
        }
      : null;

  /**
   * 用默认程序打开：失败必须给出可读反馈且**不关闭**当前预览
   * （与检查器 `runAction` 同一语义：errorMessage + error toast）。
   */
  const openDefault = async (): Promise<void> => {
    if (!currentPath) return;
    try {
      await fsOpen(currentPath);
      lastOpenError.current = null;
    } catch (cause) {
      const message = errorMessage(cause);
      const key = `${currentPath}|${message}`;
      const now = Date.now();
      const previous = lastOpenError.current;
      if (previous && previous.key === key && now - previous.at < 2000) return;
      lastOpenError.current = { key, at: now };
      showToast(t("fw.preview.openFailed", { error: message }), { kind: "error" });
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={<span className="fw-preview-dialog-title">{t("fw.preview.title")}</span>}
      size="lg"
      ariaLabel={t("fw.preview.title")}
      className="fw-preview-dialog"
      panelClassName="fw-preview-panel"
      footer={
        <>
          <div className="fw-preview-nav" role="group" aria-label={t("fw.preview.navAria")}>
            <button
              type="button"
              className="fw-icon-btn"
              disabled={index <= 0}
              aria-label={t("fw.preview.previous")}
              data-tip={t("fw.preview.previous")}
              onClick={() => selectIndex(index - 1)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <span className="fw-preview-counter" aria-live="polite">
              {t("fw.preview.counter", { index: files.length ? index + 1 : 0, total: files.length })}
            </span>
            <button
              type="button"
              className="fw-icon-btn"
              disabled={index >= files.length - 1}
              aria-label={t("fw.preview.next")}
              data-tip={t("fw.preview.next")}
              onClick={() => selectIndex(index + 1)}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="fw-preview-hint">{t("fw.preview.hint")}</p>
          <div className="fw-preview-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void openDefault()}
              disabled={!currentPath}
            >
              <ExternalLink size={13} aria-hidden="true" />
              {t("fw.preview.openDefault")}
            </button>
            <button type="button" className="btn primary" onClick={onClose}>
              {t("common.close")}
            </button>
          </div>
        </>
      }
    >
      <div className="fw-preview-layout">
        {current ? (
          <FileInfoHeader entry={effectiveEntry ?? current} path={currentPath} dir={request.dir} variant="dialog" />
        ) : (
          <p className="fw-preview-title-note" title={title}>
            {title}
          </p>
        )}
        {stale && (
          <div className="fw-preview-stale" role="status">
            <AlertTriangle size={14} aria-hidden="true" />
            <span className="fw-preview-stale-text">{t("fw.preview.staleHint")}</span>
            <button
              type="button"
              className="btn sm"
              onClick={() => void refreshCurrent()}
              disabled={refreshing}
            >
              <RefreshCw size={12} aria-hidden="true" />
              {refreshing ? t("fw.preview.refreshing") : t("fw.preview.refresh")}
            </button>
          </div>
        )}
        <div className="fw-preview-stage" data-kind={kind} data-preview-path={currentPath}>
          {target ? (
            <FilePreviewContent
              target={target}
              variant="dialog"
              onNotice={(message) => {
                if (message) showToast(message, { kind: "error" });
              }}
            />
          ) : (
            <PreviewUnsupported hint={t("fw.preview.unsupported")} />
          )}
        </div>
      </div>
    </Dialog>
  );
}
