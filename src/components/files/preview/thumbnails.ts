//! 文件缩略图请求队列（唯一实现，2026-11-23 从 FileList 抽出复用）。
//!
//! - 客户端并发 ≤3：快速滚动万级网格时不会同时发起几十个 Shell 解码；
//! - 有界 LRU 缓存：命中直接回调，不重复 IPC；
//! - 队列上限：超出时丢弃最旧的「未执行」任务（未发起 IPC，丢弃安全）；
//!   已执行任务由调用方的取消标志兜底，不会把结果写进已卸载组件。
//!
//! 后端 `fs_thumbnail` 自带磁盘缓存与解码信号量，这里只做客户端节流，
//! 不引入第二套文件访问通道。

import { fsThumbnail } from "../../../lib/bridge";

const cache = new Map<string, string | null>();
const CACHE_MAX = 300;
const QUEUE_MAX = 500;
const MAX_INFLIGHT = 3;

let inflight = 0;
const queue: Array<() => void> = [];

function pump(): void {
  while (inflight < MAX_INFLIGHT && queue.length > 0) {
    const job = queue.shift();
    if (!job) return;
    inflight += 1;
    void job();
  }
}

function cacheKey(path: string, maxPx: number): string {
  return `${maxPx}|${path}`;
}

/** 同步读缓存：`undefined` = 未请求过；`null` = 请求过但拿不到缩略图。 */
export function peekThumbnail(path: string, maxPx: number): string | null | undefined {
  return cache.get(cacheKey(path, maxPx));
}

/**
 * 请求一个缩略图（data URL）。返回值是取消函数：卸载/切换后调用，
 * 迟到的结果会被丢弃，不会写入已卸载组件。
 */
export function requestThumbnail(
  path: string,
  maxPx: number,
  onLoad: (dataUrl: string | null) => void,
): () => void {
  let cancelled = false;
  const key = cacheKey(path, maxPx);
  const cached = cache.get(key);
  if (cached !== undefined) {
    onLoad(cached);
    return () => {};
  }
  const job = () => {
    fsThumbnail(path, maxPx)
      .then((dataUrl) => {
        if (cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        // 即使已取消也写缓存：同一路径随后仍会用到，避免退回 IPC。
        cache.set(key, dataUrl);
        if (!cancelled) onLoad(dataUrl);
      })
      .catch(() => {
        cache.set(key, null);
        if (!cancelled) onLoad(null);
      })
      .finally(() => {
        inflight = Math.max(0, inflight - 1);
        pump();
      });
  };
  queue.push(job);
  while (queue.length > QUEUE_MAX) queue.shift();
  pump();
  return () => {
    cancelled = true;
  };
}

/** 测试用：清空缓存与队列，避免用例之间互相污染。 */
export function __resetThumbnailCache(): void {
  cache.clear();
  queue.length = 0;
  inflight = 0;
}
