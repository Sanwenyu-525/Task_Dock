//! 音视频预览的媒体 URL 获取与释放（唯一实现，video/audio 共用）。
//!
//! - 拿到 URL 立即登记；卸载/切换/关闭时释放且只释放一次；
//! - 请求在关闭后才返回时，先登记再立即释放，不把 token 挂到 30 分钟 TTL；
//! - 任何一次重载都会先释放上一轮的 token。

import { useCallback, useEffect, useRef, useState } from "react";
import { fsPreviewMediaUrl } from "../../../lib/bridge";
import { errorMessage } from "../../../lib/errors";
import {
  createPreviewTokenTracker,
  releaseMediaToken,
  type PreviewTokenTracker,
} from "./mediaToken";

export interface MediaPreviewUrlState {
  url: string | null;
  loading: boolean;
  error: string | null;
  /** 媒体元数据就绪（canplay/loadedmetadata）后调用，结束加载态。 */
  markReady: () => void;
  /** 媒体解码/播放失败。 */
  markError: (message: string) => void;
  retry: () => void;
  reloadKey: number;
}

export function useMediaPreviewUrl(path: string, revisionKey?: string): MediaPreviewUrlState {
  const trackerRef = useRef<PreviewTokenTracker | null>(null);
  if (!trackerRef.current) trackerRef.current = createPreviewTokenTracker();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tracker = trackerRef.current!;
    let acquired: string | null = null;
    setUrl(null);
    setError(null);
    setLoading(true);
    fsPreviewMediaUrl(path)
      .then((next) => {
        acquired = next;
        tracker.register(next);
        if (cancelled) {
          // 关闭/切换后返回：立即释放，避免占用 token 槽位直到 TTL。
          releaseMediaToken(tracker, next);
          return;
        }
        setUrl(next);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(errorMessage(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      releaseMediaToken(tracker, acquired);
    };
    // `revisionKey` 变化（同路径被外部改写）时先释放上一轮 token，再取新 URL。
  }, [path, revisionKey, reloadKey]);

  const markReady = useCallback(() => setLoading(false), []);
  const markError = useCallback((message: string) => {
    setError(message);
    setLoading(false);
  }, []);
  const retry = useCallback(() => setReloadKey((value) => value + 1), []);

  return { url, loading, error, markReady, markError, retry, reloadKey };
}
