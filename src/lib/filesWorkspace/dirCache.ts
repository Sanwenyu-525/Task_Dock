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
  /** 目录还有更多未加载的条目（翻页续拉）。 */
  hasMore: boolean;
  /**
   * 已消费的**绝对磁盘位置**（含隐藏过滤项与元数据失败项），即下一页入参 offset；
   * 来源于后端 `nextOffset`，禁止再与本页 `scanned` 二次累加。
   */
  diskScanned: number | null;
  loading: boolean;
  error: string | null;
  /** 上次加载的目录签名（轮询对比用）。 */
  signatureModifiedMs: number | null;
  fetchedAt: number;
}

const MAX_CACHE = 32;
const cache = new Map<string, DirState>();
const inflight = new Set<string>();
/** 每键请求序号：乱序响应只有最新序号允许落地（P0：强制刷新期间旧响应盖新）。 */
const reqSeq = new Map<string, number>();
type Listener = (state: DirState) => void;
const listeners = new Map<string, Set<Listener>>();

function blankState(path: string, showHidden: boolean): DirState {
  return {
    path,
    showHidden,
    listing: null,
    truncated: false,
    hasMore: false,
    diskScanned: null,
    loading: false,
    error: null,
    signatureModifiedMs: null,
    fetchedAt: 0,
  };
}

function notify(path: string, showHidden: boolean): void {
  const key = `${showHidden ? "h1" : "h0"}:${path}`;
  const state = cache.get(key);
  if (!state) return;
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of set) fn(state);
}

function touch(key: string): void {
  // LRU：先删再插，保持插入序。
  const existing = cache.get(key);
  if (existing) cache.delete(key);
  cache.set(key, existing ?? blankState(key.startsWith("h1:") ? key.slice(3) : key.slice(3), key.startsWith("h1:")));
  while (cache.size > MAX_CACHE) {
    // 订阅中的目录绝不驱逐（驱逐会让活跃视图永远收不到更新，UI 卡死在转圈）。
    // 先找最旧的无订阅条目；全部都在订阅中时容忍暂时超限（活跃窗格有限）。
    let victim: string | null = null;
    for (const candidate of cache.keys()) {
      if (!listeners.has(candidate)) {
        victim = candidate;
        break;
      }
    }
    if (victim === null) break;
    cache.delete(victim);
    reqSeq.delete(victim);
    lastSignatureProbe.delete(victim);
  }
}

export function getDirState(path: string, showHidden: boolean): DirState {
  const key = `${showHidden ? "h1" : "h0"}:${path}`;
  let state = cache.get(key);
  if (!state) {
    state = blankState(path, showHidden);
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

/** 加载目录列表（并发去重；force 绕过去重但按序号裁决乱序）。 */
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
  const seq = (reqSeq.get(key) ?? 0) + 1;
  reqSeq.set(key, seq);
  fsListDir(path, showHidden, 0)
    .then((listing) => {
      // 乱序裁决：只有最新一次请求允许落地（P0：旧响应覆盖新响应）。
      if ((reqSeq.get(key) ?? 0) !== seq) return;
      const current = getDirState(path, showHidden);
      current.listing = listing.entries;
      current.truncated = listing.hasMore;
      current.hasMore = listing.hasMore;
      current.diskScanned = listing.nextOffset;
      current.fetchedAt = Date.now();
      current.error = null;
      // 首次记录签名；后续轮询对比。
      if (current.signatureModifiedMs === null) {
        void refreshSignature(path, showHidden);
      }
    })
    .catch((e) => {
      if ((reqSeq.get(key) ?? 0) !== seq) return;
      const current = getDirState(path, showHidden);
      current.listing = null;
      current.hasMore = false;
      current.diskScanned = null;
      current.error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      inflight.delete(key);
      const current = getDirState(path, showHidden);
      current.loading = false;
      notify(path, showHidden);
    });
}

/**
 * 正在进行的用户刷新（同一 `hide:path` 合并为同一个 Promise）。
 * 连续点击刷新 / 工具栏与右键菜单同时触发时只发一次 IPC；完成后移除条目。
 */
const refreshing = new Map<string, Promise<boolean>>();

/**
 * 用户手动刷新目录（工具栏 / 右键菜单 / 错误重试的唯一入口）。
 *
 * - 同一路径 + 隐藏态的并发刷新合并为同一个 Promise，连续点击不产生额外 IPC；
 * - 递增 `reqSeq`：刷新期间由轮询/文件操作触发的旧请求晚到也不会覆盖结果；
 * - 失败时**保留上一次成功列表**，只写 `error`（首次加载失败才显示整块错误态）；
 * - 返回本次刷新是否成功（被更新请求取代时返回 false，调用方不应据此报错）。
 *
 * `force=true` 用于文件操作后的强制失效：不复用正在进行的手动刷新，
 * 保证拿到操作之后的目录内容（`invalidateDirs` 用）。
 */
export function refreshDir(path: string, showHidden: boolean, force = false): Promise<boolean> {
  const key = `${showHidden ? "h1" : "h0"}:${path}`;
  if (!force) {
    const existing = refreshing.get(key);
    if (existing) return existing;
  }
  touch(key);
  const entry = getDirState(path, showHidden);
  entry.loading = true;
  entry.error = null;
  notify(path, showHidden);
  inflight.add(key);
  const seq = (reqSeq.get(key) ?? 0) + 1;
  reqSeq.set(key, seq);
  const promise = fsListDir(path, showHidden, 0)
    .then((listing) => {
      // 乱序裁决：只有最新一次请求允许落地。
      if ((reqSeq.get(key) ?? 0) !== seq) return false;
      const current = getDirState(path, showHidden);
      current.listing = listing.entries;
      current.truncated = listing.hasMore;
      current.hasMore = listing.hasMore;
      current.diskScanned = listing.nextOffset;
      current.fetchedAt = Date.now();
      current.error = null;
      if (current.signatureModifiedMs === null) {
        void refreshSignature(path, showHidden);
      }
      return true;
    })
    .catch((e) => {
      if ((reqSeq.get(key) ?? 0) !== seq) return false;
      const current = getDirState(path, showHidden);
      // 刷新失败不得把已有列表变成空目录：保留 listing，只暴露错误。
      if (current.listing === null) {
        current.hasMore = false;
        current.diskScanned = null;
      }
      current.error = e instanceof Error ? e.message : String(e);
      return false;
    })
    .finally(() => {
      if ((reqSeq.get(key) ?? 0) === seq) {
        inflight.delete(key);
        const current = getDirState(path, showHidden);
        current.loading = false;
        notify(path, showHidden);
        // 序号仍是最新：映射里这一项属于本次请求，可以安全移除。
        refreshing.delete(key);
      }
    });
  refreshing.set(key, promise);
  return promise;
}

/**
 * 分页停滞错误码：后端声明 hasMore=true，但 `nextOffset` 未推进到当前 offset 之后。
 * 此时停止翻页并如实报错，绝不重复请求同一页，也不静默当作完整。
 */
export const PAGING_STALLED = "PAGING_STALLED";

/** 翻页续拉：把下一页条目追加到缓存列表（超限目录的剩余部分）。 */
export function loadMore(path: string, showHidden: boolean): void {
  const key = `${showHidden ? "h1" : "h0"}:${path}`;
  const state = getDirState(path, showHidden);
  if (!state.hasMore || state.loading || inflight.has(key)) return;
  // 绝对磁盘偏移：首页已由 loadDir 写入后端 nextOffset；缺省时退回 0（防御，不应发生）。
  const consumed = state.diskScanned ?? 0;
  inflight.add(key);
  const seq = (reqSeq.get(key) ?? 0) + 1;
  reqSeq.set(key, seq);
  fsListDir(path, showHidden, consumed)
    .then((listing) => {
      if ((reqSeq.get(key) ?? 0) !== seq) return;
      const current = getDirState(path, showHidden);
      // 停滞保护：还有更多但偏移未推进 → 不再翻页，保留已有列表并如实报错。
      if (listing.hasMore && listing.nextOffset <= consumed) {
        current.hasMore = false;
        current.truncated = true;
        current.error = PAGING_STALLED;
        return;
      }
      const existing = current.listing ?? [];
      const names = new Set(existing.map((e) => e.name));
      current.listing = [...existing, ...listing.entries.filter((e) => !names.has(e.name))];
      current.hasMore = listing.hasMore;
      current.truncated = listing.hasMore;
      current.diskScanned = listing.nextOffset;
      current.fetchedAt = Date.now();
    })
    .catch((e) => {
      if ((reqSeq.get(key) ?? 0) !== seq) return;
      const current = getDirState(path, showHidden);
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

/** 同一目录签名探测的最小间隔：多个分栏打开同一目录时共用一次 IPC。 */
const SIG_MIN_INTERVAL_MS = 3000;
/** 每个缓存键最近一次签名探测时间（与 cache 同生命周期）。 */
const lastSignatureProbe = new Map<string, number>();

/**
 * 轮询刷新：签名变化才重拉列表；目录失效时把 error 标为 DIR_MISSING。
 * 返回 true 表示触发了重载。
 */
export function reloadIfChanged(path: string, showHidden: boolean): boolean {
  const key = `${showHidden ? "h1" : "h0"}:${path}`;
  const state = getDirState(path, showHidden);
  if (state.loading || inflight.has(key)) return false;
  // 去重：同一目录被多个分栏 / 多次可见性回调同时触发时，只允许一个探测窗口，
  // 避免 N 个分栏 → N 倍 `fs_dir_signature` IPC。
  const now = Date.now();
  const last = lastSignatureProbe.get(key) ?? 0;
  if (now - last < SIG_MIN_INTERVAL_MS) return false;
  lastSignatureProbe.set(key, now);
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
      // 强制刷新：不复用可能在操作前就发起的手动刷新，保证拿到操作后的内容。
      if (cache.has(key)) void refreshDir(path, hidden, true);
    }
  }
}
