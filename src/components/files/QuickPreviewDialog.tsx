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

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useLocale } from "../../hooks/useLocale";
import { fsOpen, type FsEntry } from "../../lib/bridge";
import { joinPath } from "../../lib/filesWorkspace/pathUtils";
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
  const [index, setIndex] = useState(0);

  // 只在当前目录的**文件**之间切换：文件夹不进预览列表（与文件管理器一致）。
  const files = useMemo(
    () => (request ? request.entries.filter((entry) => entry.kind !== "dir") : []),
    [request],
  );
  const current = files[index] ?? null;
  const kind = getPreviewKind(current);
  const currentPath = current && request ? joinPath(request.dir, current.name) : request?.path ?? "";

  useEffect(() => {
    if (!request) return;
    const found = files.findIndex((entry) => joinPath(request.dir, entry.name) === request.path);
    setIndex(found >= 0 ? found : 0);
  }, [request, files]);

  // Escape 由全局弹层栈（Dialog）关闭；这里只处理左右切换，且不消费输入控件按键。
  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (ownsKey(event.target)) return;
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        setIndex((value) => Math.max(0, value - 1));
      } else if (event.key === "ArrowRight" && index < files.length - 1) {
        event.preventDefault();
        setIndex((value) => Math.min(files.length - 1, value + 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, index, files.length]);

  if (!request) return null;

  const title = current?.name ?? request.path.split(/[\\/]/).pop() ?? "";
  const target =
    current && kind !== "unsupported"
      ? {
          paneId: request.paneId,
          path: currentPath,
          dir: request.dir,
          name: current.name,
          size: current.size,
          entry: current,
        }
      : null;

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
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
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
              onClick={() => setIndex((value) => Math.min(files.length - 1, value + 1))}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="fw-preview-hint">{t("fw.preview.hint")}</p>
          <div className="fw-preview-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void fsOpen(currentPath)}
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
          <FileInfoHeader entry={current} path={currentPath} dir={request.dir} variant="dialog" />
        ) : (
          <p className="fw-preview-title-note" title={title}>
            {title}
          </p>
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
