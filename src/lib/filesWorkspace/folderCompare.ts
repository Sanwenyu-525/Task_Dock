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
}

interface CompareContext {
  maxDepth: number;
  maxDirs: number;
  maxFiles: number;
  dirsVisited: number;
  filesScanned: number;
  failedDirs: number;
  incomplete: boolean;
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
  let left: Awaited<ReturnType<typeof fsListDir>>;
  let right: Awaited<ReturnType<typeof fsListDir>>;
  try {
    [left, right] = await Promise.all([
      fsListDir(leftDir, false, 0),
      fsListDir(rightDir, false, 0),
    ]);
  } catch {
    ctx.failedDirs += 1;
    ctx.incomplete = true;
    return { items: [], state: "partial" };
  }
  ctx.dirsVisited += 1;
  ctx.filesScanned += left.entries.length + right.entries.length;
  if (left.hasMore || right.hasMore || ctx.filesScanned > ctx.maxFiles) {
    // 目录列表被截断：未加载的条目不能判断“不存在”，也不能用于不可靠的差异同步。
    ctx.incomplete = true;
  }

  const items = compareEntries(left.entries, right.entries);
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
        next = child.state;
      }
    }
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
      };
    }
    throw error;
  }
}
