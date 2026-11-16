//! 文件夹对比（单层）：只读、可解释；哈希由用户显式触发，不在打开目录时后台扫描。

import type { FsEntry, FsHashEntry } from "../../lib/bridge";

export type CompareStatus =
  | "leftOnly"
  | "rightOnly"
  | "kindDiff"
  | "sizeDiff"
  | "timeDiff"
  | "contentSame"
  | "contentDiff"
  | "same";

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
    return { name: left.name, left, right, status: "same", canHash: false };
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
