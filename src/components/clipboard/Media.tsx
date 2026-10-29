//! 剪贴板图片展示：缩略图带进程内缓存，大图按需加载 data URL。

import { useEffect, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { clipboardImage, clipboardThumb } from "../../lib/bridge";

const THUMB_CACHE_MAX = 240;
const thumbCache = new Map<string, string | null>();
const thumbPending = new Map<string, Promise<string | null>>();

function rememberThumb(id: string, url: string | null) {
  thumbCache.set(id, url);
  if (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest) thumbCache.delete(oldest);
  }
}

/** 缩略图 data URL；无缩略图返回 null。 */
export function useThumbnail(itemId: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(() => thumbCache.get(itemId) ?? null);
  useEffect(() => {
    if (!enabled) return;
    if (thumbCache.has(itemId)) {
      setUrl(thumbCache.get(itemId) ?? null);
      return;
    }
    let alive = true;
    let job = thumbPending.get(itemId);
    if (!job) {
      job = clipboardThumb(itemId)
        .then((v) => {
          rememberThumb(itemId, v);
          return v;
        })
        .catch(() => null)
        .finally(() => thumbPending.delete(itemId));
      thumbPending.set(itemId, job);
    }
    job.then((v) => {
      if (alive) setUrl(v);
    });
    return () => {
      alive = false;
    };
  }, [itemId, enabled]);
  return url;
}

export function ClipboardThumb({
  itemId,
  hasThumb,
  size = 40,
}: {
  itemId: string;
  hasThumb: boolean;
  size?: number;
}) {
  const url = useThumbnail(itemId, hasThumb);
  if (!url) {
    return (
      <span className="clip-thumb-placeholder" style={{ width: size, height: size }}>
        <ImageIcon size={16} />
      </span>
    );
  }
  return (
    <img
      className="clip-thumb"
      src={url}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      draggable={false}
    />
  );
}

/** 原图预览（详情面板）；加载失败时显示占位。 */
export function ClipboardLargeImage({ itemId }: { itemId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    clipboardImage(itemId)
      .then((v) => {
        if (alive) setUrl(v);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [itemId]);

  if (failed) return <div className="clip-image-hint">图片文件缺失或无法读取</div>;
  if (!url) return <div className="clip-image-hint">正在加载原图…</div>;
  return <img className="clip-image-large" src={url} alt="剪贴板图片预览" draggable={false} />;
}
