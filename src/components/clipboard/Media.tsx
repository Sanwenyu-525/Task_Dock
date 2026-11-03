//! 剪贴板图片展示：缩略图带进程内缓存，大图按需加载 data URL。
//!
//! 原图 data URL 体量大（上限 40MB），因此：
//! - 加载 promise 全局去重（详情大图与灯箱同时触发只发一次 IPC）；
//! - 成功结果进 LRU 缓存（上限 2 条，重复打开不重复 IPC，超出即释放最旧）。

import { useEffect, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { clipboardImage, clipboardThumb } from "../../lib/bridge";

const THUMB_CACHE_MAX = 240;
const thumbCache = new Map<string, string | null>();
const thumbPending = new Map<string, Promise<string | null>>();

const IMAGE_CACHE_MAX = 2;
const imageCache = new Map<string, string>();
const imagePending = new Map<string, Promise<string | null>>();

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

/**
 * 原图 data URL 加载（共享缓存）：resolve null 表示缓存文件缺失，
 * reject 表示读取失败（图片过大 / IO 错误）。
 */
export function loadLargeImage(itemId: string): Promise<string | null> {
  const hit = imageCache.get(itemId);
  if (hit) {
    // LRU 触碰：最近使用的留在缓存里
    imageCache.delete(itemId);
    imageCache.set(itemId, hit);
    return Promise.resolve(hit);
  }
  let job = imagePending.get(itemId);
  if (!job) {
    job = clipboardImage(itemId)
      .then((v) => {
        if (v) {
          imageCache.set(itemId, v);
          if (imageCache.size > IMAGE_CACHE_MAX) {
            const oldest = imageCache.keys().next().value;
            if (oldest) imageCache.delete(oldest);
          }
        }
        return v;
      })
      .finally(() => imagePending.delete(itemId));
    imagePending.set(itemId, job);
  }
  return job;
}

export type LargeImageState = "loading" | "ready" | "missing" | "error";

/** 原图加载状态机；多个消费者共享同一次 IPC。 */
export function useLargeImage(
  itemId: string,
  enabled: boolean,
): { state: LargeImageState; url: string | null; error: string } {
  const [state, setState] = useState<LargeImageState>("loading");
  const [url, setUrl] = useState<string | null>(() => imageCache.get(itemId) ?? null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    const cached = imageCache.get(itemId);
    if (cached) {
      setState("ready");
      setUrl(cached);
      return;
    }
    let alive = true;
    setState("loading");
    setUrl(null);
    setError("");
    loadLargeImage(itemId).then(
      (v) => {
        if (!alive) return;
        if (v) {
          setUrl(v);
          setState("ready");
        } else {
          setState("missing");
        }
      },
      (e) => {
        if (!alive) return;
        setError(String(e));
        setState("error");
      },
    );
    return () => {
      alive = false;
    };
  }, [itemId, enabled]);
  return { state, url, error };
}

/**
 * 缩略图；提供 onOpen 时整块成为「直接打开大图」的按钮（不必先进详情）。
 * 无缩略图也要可点：灯箱会如实报出缺失/读取失败，而不是给一个死图标。
 */
export function ClipboardThumb({
  itemId,
  hasThumb,
  size = 40,
  onOpen,
}: {
  itemId: string;
  hasThumb: boolean;
  size?: number;
  onOpen?: () => void;
}) {
  const url = useThumbnail(itemId, hasThumb);
  const body = url ? (
    <img
      className="clip-thumb"
      src={url}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      draggable={false}
    />
  ) : (
    <span className="clip-thumb-placeholder" style={{ width: size, height: size }}>
      <ImageIcon size={16} />
    </span>
  );
  if (!onOpen) return body;
  return (
    <button
      type="button"
      className="clip-thumb-open"
      onClick={(e) => {
        // 卡片本身是 role=button：不拦住就会同时打开详情
        e.stopPropagation();
        onOpen();
      }}
      // Enter 冒泡到卡片会再触发一次「打开详情」；Space 同理，按键不外传
      onKeyDown={(e) => e.stopPropagation()}
      data-tip="点击查看大图"
      aria-label="查看大图"
    >
      {body}
    </button>
  );
}

/**
 * 原图预览（详情面板）；提供 onOpen 时整图成为进入灯箱的按钮。
 * 加载失败/缺失显示占位，不渲染可点击目标。
 */
export function ClipboardLargeImage({
  itemId,
  onOpen,
}: {
  itemId: string;
  onOpen?: () => void;
}) {
  const { state, url, error } = useLargeImage(itemId, true);
  if (state === "error") {
    return <div className="clip-image-hint">图片读取失败：{error}</div>;
  }
  if (state === "missing") {
    return <div className="clip-image-hint">图片文件缺失或已被清理</div>;
  }
  if (state === "loading") return <div className="clip-image-hint">正在加载原图…</div>;
  const img = (
    <img className="clip-image-large" src={url ?? undefined} alt="剪贴板图片预览" draggable={false} />
  );
  if (!onOpen) return img;
  return (
    <button
      type="button"
      className="clip-image-open"
      onClick={onOpen}
      data-tip="点击查看大图"
      aria-label="查看大图"
    >
      {img}
    </button>
  );
}
