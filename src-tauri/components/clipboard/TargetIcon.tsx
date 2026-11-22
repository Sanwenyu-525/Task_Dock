//! 目标窗口的真实应用图标（16–20px）。
//!
//! - 后端按当前窗口身份（HWND + 选中时的 PID）解析 exe 路径并提取图标，
//!   前端不传任意路径；PID 不一致时后端返回 null，避免 HWND/PID 复用后错配。
//! - 同一 exe 复用同一份图标缓存；加载失败（窗口已关闭、提取失败、限流）
//!   按窗口身份做短时负缓存，避免刷新时反复重试。
//! - 前端并发上限与后端配额一致（2），多窗口同时出现时排队而不是被限流拒绝；
//!   组件卸载只停止写回状态，不保留订阅。

import { useEffect, useState } from "react";
import { AppWindow } from "lucide-react";
import { clipboardTargetIcon } from "../../lib/bridge";

const MAX_CONCURRENT_LOADS = 2;
const CACHE_LIMIT = 128;
const NEGATIVE_TTL_MS = 60_000;

/** exe 路径（小写）→ 图标 data URL 或 null（该 exe 确实没有可用图标）。 */
const iconCache = new Map<string, string | null>();
/** `${hwnd}:${pid}` → 失败时间；窗口关闭/限流等失败不与同 exe 的其他窗口共享。 */
const negativeCache = new Map<string, number>();

let activeLoads = 0;
const waiters: Array<() => void> = [];
/** 同一 exe 的并发请求合并，多个窗口同时出现时只提取一次。 */
const inflight = new Map<string, Promise<string | null>>();

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeLoads >= MAX_CONCURRENT_LOADS) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  activeLoads += 1;
  try {
    return await task();
  } finally {
    activeLoads -= 1;
    const next = waiters.shift();
    if (next) next();
  }
}

function writeBounded<K, V>(map: Map<K, V>, key: K, value: V) {
  if (map.size >= CACHE_LIMIT) map.clear();
  map.set(key, value);
}

/**
 * 加载图标；返回 null 表示回退通用图标。
 * `exePath` 只作缓存键，真正的路径由后端根据窗口身份解析。
 */
async function loadIcon(
  exeKey: string,
  identityKey: string,
  hwnd: number,
  pid: number,
): Promise<string | null> {
  if (iconCache.has(exeKey)) return iconCache.get(exeKey) ?? null;
  const failedAt = negativeCache.get(identityKey);
  if (failedAt !== undefined && Date.now() - failedAt < NEGATIVE_TTL_MS) {
    return null;
  }
  const existing = inflight.get(exeKey);
  if (existing) return existing;

  const task = withSlot(async () => {
    try {
      return await clipboardTargetIcon(hwnd, pid);
    } catch {
      return null;
    }
  }).then((url) => {
    if (url) {
      writeBounded(iconCache, exeKey, url);
      negativeCache.delete(identityKey);
    } else {
      writeBounded(negativeCache, identityKey, Date.now());
    }
    return url;
  });
  inflight.set(exeKey, task);
  void task.finally(() => inflight.delete(exeKey));
  return task;
}

export default function TargetIcon({
  hwnd,
  pid,
  exePath,
  size = 18,
}: {
  hwnd: number;
  pid: number;
  exePath: string;
  size?: number;
}) {
  const exeKey = exePath.trim().toLowerCase();
  const identityKey = `${hwnd}:${pid}`;
  const [url, setUrl] = useState<string | null>(
    () => (exeKey ? iconCache.get(exeKey) ?? null : null),
  );

  useEffect(() => {
    if (!exeKey) {
      setUrl(null);
      return;
    }
    const cached = iconCache.get(exeKey);
    if (cached !== undefined) {
      setUrl(cached);
      return;
    }
    let alive = true;
    void loadIcon(exeKey, identityKey, hwnd, pid).then((next) => {
      if (alive) setUrl(next);
    });
    return () => {
      alive = false;
    };
  }, [exeKey, identityKey, hwnd, pid]);

  return (
    <span
      className="clip-target-icon"
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          onError={() => {
            writeBounded(iconCache, exeKey, null);
            setUrl(null);
          }}
        />
      ) : (
        <AppWindow size={Math.round(size * 0.72)} strokeWidth={1.6} />
      )}
    </span>
  );
}
