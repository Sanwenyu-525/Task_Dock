//! 文件夹对比：单层可解释差异 + 有上限的递归比较；哈希由用户显式触发。
//!
//! 关键语义：两个同名目录在**没有检查内部内容**时不能显示“内容相同”。
//! `compareEntries()` 只做当前层；`compareFolders()` 按用户选择的深度递归，
//! 并对目录条目给出 dirUnchecked / dirSame / dirDiff / dirPartial。

import { fsListDir, type FsEntry, type FsHashEntry } from "../../lib/bridge";

export type CompareStatus =
  | "leftOnly"
  | "rightOnly"
  | "kindDiff"
  | "sizeDiff"
  | "timeDiff"
  | "contentSame"
  | "contentDiff"
  | "same"
  | "dirUnchecked"
  | "dirSame"
  | "dirDiff"
  | "dirPartial";

export interface CompareItem {
  name: string;
  left: FsEntry | null;
  right: FsEntry | null;
  status: CompareStatus;
  /** 两边都是同大小文件且未做哈希：可由用户显式计算 SHA-256。 */
  canHash: boolean;
  /** 目录递归后第一处差异的相对路径，供表格定位；无差异时为空。 */
  detail?: string;
}

export function compareEntries(left: FsEntry[], right: FsEntry[]): CompareItem[] {
  const rightByName = new Map(right.map((entry) => [entry.name.toLocaleLowerCase(), entry]));
  const seen = new Set<string>();
  const items: CompareItem[] = [];

  for (const entry of left) {
    const key = entry.name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const other = rightByName.get(key) ?? null;
    items.push(buildItem(entry, other));
  }
  for (const entry of right) {
    const key = entry.name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(buildItem(null, entry));
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}

function buildItem(left: FsEntry | null, right: FsEntry | null): CompareItem {
  if (!left) return { name: right?.name ?? "", left: null, right, status: "rightOnly", canHash: false };
  if (!right) return { name: left.name, left, right: null, status: "leftOnly", canHash: false };
  const sameKind = left.kind === right.kind;
  if (!sameKind) {
    return { name: left.name, left, right, status: "kindDiff", canHash: false };
  }
  if (left.kind === "dir") {
    // 当前层只知道两边都有这个目录；内部内容必须由递归比较确认。
    return { name: left.name, left, right, status: "dirUnchecked", canHash: false };
  }
  const leftSize = left.size ?? 0;
  const rightSize = right.size ?? 0;
  if (leftSize !== rightSize) {
    return { name: left.name, left, right, status: "sizeDiff", canHash: false };
  }
  if ((left.modifiedMs ?? 0) !== (right.modifiedMs ?? 0)) {
    return { name: left.name, left, right, status: "timeDiff", canHash: true };
  }
  return { name: left.name, left, right, status: "same", canHash: true };
}

/** 需要哈希的完整路径（同大小文件对）；调用方用目录路径 + 名称拼接。 */
export function hashTargets(items: CompareItem[], leftDir: string, rightDir: string): string[] {
  const sep = leftDir.includes("\\") ? "\\" : "/";
  const targets: string[] = [];
  for (const item of items) {
    if (!item.left || !item.right || item.left.kind !== "file" || item.right.kind !== "file") continue;
    if (item.canHash) {
      targets.push(`${leftDir.replace(/[\\/]$/, "")}${sep}${item.left.name}`);
      targets.push(`${rightDir.replace(/[\\/]$/, "")}${sep}${item.right.name}`);
    }
  }
  return targets;
}

/**
 * 用完整路径哈希表更新状态（文件夹对比实际调用）。
 * 左侧/右侧路径均已知，避免仅靠文件名误判同名不同目录。
 */
export function applyHashesByPath(
  items: CompareItem[],
  leftDir: string,
  rightDir: string,
  hashes: FsHashEntry[],
): CompareItem[] {
  const byPath = new Map(
    hashes
      .filter((entry) => entry.hash)
      .map((entry) => [entry.path.toLocaleLowerCase(), entry.hash as string]),
  );
  const sep = leftDir.includes("\\") ? "\\" : "/";
  return items.map((item) => {
    if (!item.left || !item.right || item.left.kind !== "file" || item.right.kind !== "file") return item;
    if (item.status !== "timeDiff" && item.status !== "same") return item;
    const leftPath = `${leftDir.replace(/[\\/]$/, "")}${sep}${item.left.name}`;
    const rightPath = `${rightDir.replace(/[\\/]$/, "")}${sep}${item.right.name}`;
    const leftHash = byPath.get(leftPath.toLocaleLowerCase());
    const rightHash = byPath.get(rightPath.toLocaleLowerCase());
    if (!leftHash || !rightHash) return item;
    return { ...item, status: leftHash === rightHash ? "contentSame" : "contentDiff" };
  });
}

export interface CompareFoldersOptions {
  /** 0 = 仅当前层；1 = 递归 1 层；…… 上限 4。 */
  maxDepth: number;
  maxDirs?: number;
  maxFiles?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { dirsVisited: number; filesScanned: number }) => void;
}

export interface CompareFoldersResult {
  items: CompareItem[];
  complete: boolean;
  failedDirs: number;
  dirsVisited: number;
  filesScanned: number;
  cancelled: boolean;
  /** 整次对比最严重的不完整原因；null = 完整。 */
  limit: ReadLimit;
}

interface CompareContext {
  maxDepth: number;
  maxDirs: number;
  maxFiles: number;
  dirsVisited: number;
  filesScanned: number;
  failedDirs: number;
  incomplete: boolean;
  limit: ReadLimit;
  signal?: AbortSignal;
  onProgress?: CompareFoldersOptions["onProgress"];
}

type DirState = "same" | "diff" | "partial";

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

function statusState(status: CompareStatus): DirState {
  if (status === "leftOnly" || status === "rightOnly" || status === "kindDiff" || status === "sizeDiff" || status === "timeDiff" || status === "contentDiff" || status === "dirDiff") {
    return "diff";
  }
  if (status === "same" || status === "dirPartial" || status === "dirUnchecked") {
    // 同名/同大小/同时间只是元数据一致，未哈希不能宣称内容相同；
    // 同名目录未递归或未完整读取也不能宣称相同。
    return "partial";
  }
  return "same";
}

function mergeState(current: DirState, next: DirState): DirState {
  if (current === "diff" || next === "diff") return "diff";
  if (current === "partial" || next === "partial") return "partial";
  return "same";
}

function firstDiff(items: CompareItem[]): string | null {
  for (const item of items) {
    if (statusState(item.status) === "diff") return item.detail ?? item.name;
  }
  return null;
}

/** 目录未读全的原因；null = 正常读完。 */
export type ReadLimit = "budget" | "stalled" | "failed" | null;

export interface ReadAllResult {
  entries: FsEntry[];
  /** 不完整原因：预算截断 / 分页停滞 / IPC 失败；null = 正常读完。 */
  limit: ReadLimit;
  /** 本目录实际保留进 entries 的条数（已计入 ctx.filesScanned）。 */
  consumed: number;
}

/** 合并两侧目录的不完整原因：failed > stalled > budget。 */
function mergeLimit(a: ReadLimit, b: ReadLimit): ReadLimit {
  if (a === "failed" || b === "failed") return "failed";
  if (a === "stalled" || b === "stalled") return "stalled";
  if (a === "budget" || b === "budget") return "budget";
  return null;
}

/**
 * 翻页读完一个目录：按 nextOffset 续拉直到 hasMore=false；停滞即停止并标记 stalled。
 * 预算是左右两侧、所有目录共用的全局已消费预算：翻页前按剩余预算有界保留条目，
 * 只把真正保留进 entries 的条数计入 ctx.filesScanned。
 */
async function readAllDir(dir: string, ctx: CompareContext): Promise<ReadAllResult> {
  const entries: FsEntry[] = [];
  let offset = 0;
  for (;;) {
    if (ctx.signal?.aborted) throw abortError();
    const remaining = ctx.maxFiles - ctx.filesScanned;
    if (remaining <= 0) {
      return { entries, limit: "budget", consumed: entries.length };
    }
    let listing: Awaited<ReturnType<typeof fsListDir>>;
    try {
      listing = await fsListDir(dir, false, offset);
    } catch {
      return { entries, limit: "failed", consumed: entries.length };
    }
    const keep = Math.min(listing.entries.length, remaining);
    entries.push(...listing.entries.slice(0, keep));
    ctx.filesScanned += keep;
    // 本页超出剩余预算：有界保留 remaining 条，停止翻页并标记预算截断。
    if (listing.entries.length > remaining) {
      return { entries, limit: "budget", consumed: entries.length };
    }
    // 停滞保护：hasMore 但 nextOffset 未推进 → 保留本页条目，不再翻页，未读全。
    if (listing.hasMore && listing.nextOffset <= offset) {
      return { entries, limit: "stalled", consumed: entries.length };
    }
    if (!listing.hasMore) break;
    offset = listing.nextOffset;
  }
  return { entries, limit: null, consumed: entries.length };
}

/** 递归比较两个目录；达到目录/文件/时间上限或读取失败时返回 partial，不冒充完整。 */
async function compareDir(
  leftDir: string,
  rightDir: string,
  depth: number,
  ctx: CompareContext,
): Promise<{ items: CompareItem[]; state: DirState }> {
  if (ctx.signal?.aborted) throw abortError();
  if (ctx.dirsVisited >= ctx.maxDirs || ctx.filesScanned >= ctx.maxFiles) {
    ctx.incomplete = true;
    return { items: [], state: "partial" };
  }
  // 串行先左后右：右侧按左侧真实消费后的剩余预算读取，禁止 Promise.all 并行双读。
  const leftR = await readAllDir(leftDir, ctx);
  if (leftR.limit === "failed") {
    ctx.failedDirs += 1;
    ctx.incomplete = true;
    ctx.limit = mergeLimit(ctx.limit, "failed");
    return { items: [], state: "partial" };
  }
  const rightR = await readAllDir(rightDir, ctx);
  if (rightR.limit === "failed") {
    ctx.failedDirs += 1;
    ctx.incomplete = true;
    ctx.limit = mergeLimit(ctx.limit, "failed");
    return { items: [], state: "partial" };
  }

  ctx.dirsVisited += 1;
  // 条目消耗已在 readAllDir 内记账，这里不再用 entries.length 二次累加。
  const dirLimit = mergeLimit(leftR.limit, rightR.limit);
  if (dirLimit !== null) {
    // 目录列表未读全：未加载的条目不能判断“不存在”，也不能用于不可靠的差异同步。
    ctx.incomplete = true;
    ctx.limit = mergeLimit(ctx.limit, dirLimit);
  }

  const items = compareEntries(leftR.entries, rightR.entries);
  let state: DirState = "same";
  for (const item of items) {
    let next = statusState(item.status);
    if (item.left?.kind === "dir" && item.right?.kind === "dir") {
      if (depth >= ctx.maxDepth) {
        item.status = "dirUnchecked";
        next = "partial";
      } else {
        const child = await compareDir(
          `${leftDir.replace(/[\\/]$/, "")}${leftDir.includes("\\") ? "\\" : "/"}${item.left.name}`,
          `${rightDir.replace(/[\\/]$/, "")}${rightDir.includes("\\") ? "\\" : "/"}${item.right.name}`,
          depth + 1,
          ctx,
        );
        item.status = child.state === "same" ? "dirSame" : child.state === "diff" ? "dirDiff" : "dirPartial";
        if (child.state === "diff") {
          const nested = firstDiff(child.items);
          item.detail = nested ? `${item.name}/${nested}` : item.name;
        }
        next = child.state;
      }
    }
    if (next === "diff" && !item.detail) item.detail = item.name;
    state = mergeState(state, next);
  }
  ctx.onProgress?.({ dirsVisited: ctx.dirsVisited, filesScanned: ctx.filesScanned });
  return { items, state };
}

/**
 * 用户明确选择深度后调用：只扫描两个目标目录及其子目录，不跟随符号链接；
 * 任何读取失败、列表截断或上限命中都会返回 complete=false，UI 不得启用复制。
 */
export async function compareFolders(
  leftDir: string,
  rightDir: string,
  options: CompareFoldersOptions,
): Promise<CompareFoldersResult> {
  const ctx: CompareContext = {
    maxDepth: Math.max(0, Math.min(4, Math.floor(options.maxDepth))),
    maxDirs: Math.max(2, options.maxDirs ?? 200),
    maxFiles: Math.max(2, options.maxFiles ?? 10000),
    dirsVisited: 0,
    filesScanned: 0,
    failedDirs: 0,
    incomplete: false,
    limit: null,
    signal: options.signal,
    onProgress: options.onProgress,
  };
  try {
    const result = await compareDir(leftDir, rightDir, 0, ctx);
    return {
      items: result.items,
      complete: !ctx.incomplete && !options.signal?.aborted,
      failedDirs: ctx.failedDirs,
      dirsVisited: ctx.dirsVisited,
      filesScanned: ctx.filesScanned,
      cancelled: Boolean(options.signal?.aborted),
      limit: ctx.limit,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        items: [],
        complete: false,
        failedDirs: ctx.failedDirs,
        dirsVisited: ctx.dirsVisited,
        filesScanned: ctx.filesScanned,
        cancelled: true,
        limit: ctx.limit,
      };
    }
    throw error;
  }
}
