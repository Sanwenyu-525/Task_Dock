//! 收集箱条目的图片附件：缩略图行 + 多图大图浏览。
//!
//! - 缩略图按附件 ID 从后端读取（`quick_capture_attachment_thumb`，约 192px 的
//!   data URL），进程内做小容量缓存：列表切筛选/重渲染不会重复 IPC；
//! - 点击任一缩略图打开对话框，支持左右切换与 Esc 关闭（Escape 交给统一弹层栈）；
//! - 只读展示：附件的生命周期挂在条目上（删除条目由后端连同文件一起回收）。

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import {
  quickCaptureAttachmentPreview,
  quickCaptureAttachmentThumb,
  type CaptureAttachment,
} from "../../lib/bridge";
import { formatError } from "../../capture/captureUtils";

/** 缩略图缓存上限：超过后整体清空，避免长期运行无限增长。 */
const THUMB_CACHE_LIMIT = 240;

const thumbCache = new Map<string, string | null>();
const thumbInflight = new Map<string, Promise<string | null>>();

function rememberThumb(id: string, url: string | null) {
  if (thumbCache.size >= THUMB_CACHE_LIMIT) thumbCache.clear();
  thumbCache.set(id, url);
}

/** 读取缩略图（带缓存与并发去重）；失败向上抛，由调用方决定展示占位。 */
function loadThumb(id: string): Promise<string | null> {
  if (thumbCache.has(id)) return Promise.resolve(thumbCache.get(id) ?? null);
  const existing = thumbInflight.get(id);
  if (existing) return existing;
  const task = quickCaptureAttachmentThumb(id)
    .then((url) => {
      rememberThumb(id, url);
      return url;
    })
    .finally(() => {
      thumbInflight.delete(id);
    });
  thumbInflight.set(id, task);
  return task;
}

export interface CaptureAttachmentStripProps {
  attachments: CaptureAttachment[];
  /** list：卡片内的紧凑行；detail：右栏的稍大预览 */
  variant?: "list" | "detail";
}

export default function CaptureAttachmentStrip({
  attachments,
  variant = "list",
}: CaptureAttachmentStripProps) {
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const [viewer, setViewer] = useState<number | null>(null);
  const [preview, setPreview] = useState<{
    id: string;
    url: string | null;
    error: string | null;
    loading: boolean;
  }>({ id: "", url: null, error: null, loading: false });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 附件列表变化：补齐缺失的缩略图（已缓存的立即返回）
  useEffect(() => {
    if (attachments.length === 0) return;
    let cancelled = false;
    void (async () => {
      const next: Record<string, string | null> = {};
      await Promise.all(
        attachments.map(async (item) => {
          try {
            next[item.id] = await loadThumb(item.id);
          } catch {
            next[item.id] = null;
          }
        }),
      );
      if (!cancelled && mountedRef.current) {
        setThumbs((current) => ({ ...current, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachments]);

  // 打开大图：按需读取原图（不使用缩略图放大冒充）
  useEffect(() => {
    if (viewer === null) return;
    const item = attachments[viewer];
    if (!item) return;
    let cancelled = false;
    setPreview({ id: item.id, url: null, error: null, loading: true });
    void quickCaptureAttachmentPreview(item.id)
      .then((url) => {
        if (cancelled || !mountedRef.current) return;
        setPreview({
          id: item.id,
          url,
          error: url ? null : "原图不存在",
          loading: false,
        });
      })
      .catch((error) => {
        if (cancelled || !mountedRef.current) return;
        setPreview({ id: item.id, url: null, error: formatError(error), loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [viewer, attachments]);

  // 左右切换；Escape 由 Dialog 的弹层栈处理（先关预览，不影响下层页面）
  useEffect(() => {
    if (viewer === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setViewer((current) => Math.max(0, (current ?? 0) - 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setViewer((current) => Math.min(attachments.length - 1, (current ?? 0) + 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewer, attachments.length]);

  if (attachments.length === 0) return null;
  const limit = variant === "detail" ? attachments.length : 4;
  const shown = attachments.slice(0, limit);
  const hidden = attachments.length - shown.length;

  return (
    <>
      <div
        className={`inbox-attachments is-${variant}`}
        role="group"
        aria-label={`图片附件（${attachments.length} 张）`}
      >
        {shown.map((item, index) => {
          const thumb = thumbs[item.id];
          return (
            <button
              key={item.id}
              type="button"
              className={`inbox-attachment${thumb ? "" : " is-pending"}`}
              aria-label={`查看第 ${index + 1} 张图片大图`}
              data-tip={`第 ${index + 1} 张 · 点击查看大图`}
              onClick={() => setViewer(index)}
            >
              {thumb ? (
                <img src={thumb} alt="" draggable={false} loading="lazy" />
              ) : (
                <ImageOff size={13} aria-hidden="true" />
              )}
            </button>
          );
        })}
        {hidden > 0 && (
          <button
            type="button"
            className="inbox-attachment-more"
            aria-label={`查看全部 ${attachments.length} 张图片`}
            onClick={() => setViewer(shown.length)}
          >
            +{hidden}
          </button>
        )}
      </div>

      <Dialog
        open={viewer !== null}
        onClose={() => setViewer(null)}
        size="lg"
        ariaLabel="图片预览"
        panelClassName="inbox-image-dialog"
        title={`图片 ${(viewer ?? 0) + 1} / ${attachments.length}`}
        footer={
          <div className="inbox-image-nav">
            <button
              type="button"
              className="btn sm"
              aria-label="上一张"
              disabled={(viewer ?? 0) <= 0}
              onClick={() => setViewer((current) => Math.max(0, (current ?? 0) - 1))}
            >
              <ChevronLeft size={13} aria-hidden="true" />
              上一张
            </button>
            <button
              type="button"
              className="btn sm"
              aria-label="下一张"
              disabled={(viewer ?? 0) >= attachments.length - 1}
              onClick={() =>
                setViewer((current) => Math.min(attachments.length - 1, (current ?? 0) + 1))
              }
            >
              下一张
              <ChevronRight size={13} aria-hidden="true" />
            </button>
          </div>
        }
      >
        <div className="inbox-image-stage">
          {preview.loading && <span className="inbox-image-hint">正在读取原图…</span>}
          {preview.error && <span className="inbox-image-hint is-error">{preview.error}</span>}
          {preview.url && (
            <img src={preview.url} alt={`附件 ${(viewer ?? 0) + 1}`} draggable={false} />
          )}
        </div>
      </Dialog>
    </>
  );
}
