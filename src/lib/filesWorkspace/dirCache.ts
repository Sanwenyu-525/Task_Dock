//! 目录列表缓存（进程内单例，非持久化）。
//!
//! 设计：
//! - 同一目录只发起一次 IPC（多窗格打开同一目录复用缓存）；
//! - 订阅者按路径注册；失效/刷新广播给该路径全部订阅者；
//! - 轮询刷新走 `fs_dir_signature`（单次 metadata，极轻），签名变化才重拉列表；
//! - 缓存 LRU 32 条（按路径），只缓存列表载荷不缓存选择状态；
//! - 切换目录不会出现旧响应覆盖新目录：按路径精确分发，乱序响应只影响对应路径。

import { fsDirSignature, fsListDir, type FsEntry } from "../bridge";

export type { FsEntry as DirEntry };

export interface DirState {
  path: string;
  showHidden: boolean;
  listing: FsEntry[] | null;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  /** 上次加载的目录签名（轮询对比用）。 */
  signatureModifiedMs: number | null;
  fetchedAt: number;
}

const MAX_CACHE = 32;
const cache = new Map<string, DirState>();
const inflight = new Set<string>();
type Listener = (state: DirState) => void;
const listeners = new Map<string, Set<Listener>>();

function notify(path: string, showHidden: boolean): void {
  const key = `${showHidden ? "h1" : "h0"}:${path}`;
  const state = cache.get(key);
  if (!state) return;
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of set) fn(state);
}

function touch(path: string): void {
  // LRU：先删再插，保持插入序。
  const existing = cache.get(path);
  if (existing) cache.delete(path);
  cache.set(path, existing ?? {
    path,
    showHidden: false,
    listing: null,
    truncated: false,
    loading: false,
    error: null,
    signatureModifiedMs: null,
    fetchedAt: 0,
  });
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    listeners.delete(oldest);
  }
}

export function getDirState(path: string, showHidden: boolean): DirState {
  const key = `${showHidden ? "h1" : "h0"}:${path}`;
  let state = cache.get(key);
  if (!state) {
    state = {
      path,
      showHidden,
      listing: null,
      truncated: false,
      loading: false,
      error: null,
      signatureModifiedMs: null,
      fetchedAt: 0,
    };
    cache.set(key, state);
  }
  return state;
}

export function subscribeDir(
  path: string,
  showHidden: boolean,
  listener: Listener,
): () => void {
  const key = `${showHidden ? "h1" : "h0"}:${path}`;
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(key);
  };
}

/** 加载目录列表（并发去重；错误落在状态里，不抛给调用方）。 */
export function loadDir(path: string, showHidden: boolean, force = false): void {
  const key = `${showHidden ? "h1" : "h0"}:${path}`;
  const state = getDirState(path, showHidden);
  if (state.loading && !force) return;
  if (inflight.has(key) && !force) return;
  touch(key);
  const entry = getDirState(path, showHidden);
  entry.loading = true;
  entry.error = null;
  notify(path, showHidden);
  inflight.add(key);
  fsListDir(path, showHidden)
    .then((listing) => {
      const current = getDirState(path, showHidden);
      current.listing = listing.entries;
      current.truncated = listing.truncated;
      current.fetchedAt = Date.now();
      // 首次记录签名；后续轮询对比。
      if (current.signatureModifiedMs === null) {
        void refreshSignature(path, showHidden);
      }
    })
    .catch((e) => {
      const current = getDirState(path, showHidden);
      current.listing = null;
      current.error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      inflight.delete(key);
      const current = getDirState(path, showHidden);
      current.loading = false;
      notify(path, showHidden);
    });
}

/** 拉一次目录签名并写入缓存（不通知订阅者——签名不是内容）。 */
async function refreshSignature(path: string, showHidden: boolean): Promise<void> {
  try {
    const sig = await fsDirSignature(path);
    const state = getDirState(path, showHidden);
    state.signatureModifiedMs = sig.modifiedMs;
    if (!sig.exists || !sig.isDir) {
      state.error = state.error ?? "DIR_MISSING";
    }
  } catch {
    // 签名失败不打扰列表展示。
  }
}

/**
 * 轮询刷新：签名变化才重拉列表；目录失效时把 error 标为 DIR_MISSING。
 * 返回 true 表示触发了重载。
 */
export function reloadIfChanged(path: string, showHidden: boolean): boolean {
  const state = getDirState(path, showHidden);
  if (state.loading || inflight.has(`${showHidden ? "h1" : "h0"}:${path}`)) return false;
  const known = state.signatureModifiedMs;
  if (known === null) {
    refreshSignature(path, showHidden);
    return false;
  }
  void (async () => {
    try {
      const sig = await fsDirSignature(path);
      if (!sig.exists || !sig.isDir) {
        const cur = getDirState(path, showHidden);
        cur.error = "DIR_MISSING";
        notify(path, showHidden);
        return;
      }
      if (sig.modifiedMs !== known) {
        const cur = getDirState(path, showHidden);
        cur.signatureModifiedMs = sig.modifiedMs;
        loadDir(path, showHidden, true);
      }
    } catch {
      // 签名探测失败：跳过本轮。
    }
  })();
  return false;
}

/** 文件操作完成后显式刷新相关目录（源与目标；两种隐藏态缓存都失效）。 */
export function invalidateDirs(paths: string[]): void {
  for (const path of paths) {
    for (const hidden of [false, true]) {
      const key = `${hidden ? "h1" : "h0"}:${path}`;
      if (cache.has(key)) loadDir(path, hidden, true);
    }
  }
}
