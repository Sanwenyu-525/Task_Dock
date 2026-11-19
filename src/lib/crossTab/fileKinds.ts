//! 路径 → 工作篮条目输入：按真实文件系统形态识别 file / directory / rejected。
//!
//! 不做「按扩展名猜目录」：一律以 `fs_stat`（Rust `stat_path`，读真实 metadata）
//! 为准；批量查询按块发送，单块失败才退化为逐条查询（有上限，不会为每个文件
//! 无限发 IPC）。原始选择顺序保持不变。

import type { FsStat } from "../contracts/models";
import type { TransferItemInput, TransferRejection } from "./types";

/** 单次 `fs_stat` 的块大小：远小于后端 `MAX_OP_PATHS`，单块失败代价可控。 */
export const STAT_CHUNK = 80;

export type StatFn = (paths: string[]) => Promise<FsStat[]>;

export interface PathInputResult {
  inputs: TransferItemInput[];
  rejected: TransferRejection[];
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 真实形态 → 条目类型；`missing` 返回 null（调用方按 rejected 处理）。 */
export function itemTypeForStat(stat: Pick<FsStat, "exists" | "kind">): "file" | "directory" | null {
  if (!stat.exists || stat.kind === "missing") return null;
  return stat.kind === "dir" ? "directory" : "file";
}

export function rejectionFor(path: string, reason: string): TransferRejection {
  return {
    title: basename(path),
    code: "TRANSFER_SOURCE_MISSING",
    message: `${reason}：${path}`,
  };
}

async function statOne(stat: StatFn, path: string): Promise<FsStat | null> {
  try {
    const [result] = await stat([path]);
    return result ?? null;
  } catch {
    return null;
  }
}

/**
 * 批量识别路径形态。
 *
 * @param paths 原始选择顺序（会去重但保持首次出现的位置）
 * @param stat  `fs_stat` 封装（测试可注入）
 * @param sourceModule 来源模块（写入条目的 `sourceModule`）
 */
export async function resolvePathInputs(
  paths: string[],
  stat: StatFn,
  sourceModule: string,
): Promise<PathInputResult> {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    const key = path.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(path);
  }

  const stats = new Map<string, FsStat | null>();
  for (let offset = 0; offset < ordered.length; offset += STAT_CHUNK) {
    const chunk = ordered.slice(offset, offset + STAT_CHUNK);
    let batch: FsStat[] | null = null;
    try {
      batch = await stat(chunk);
    } catch {
      batch = null;
    }
    if (batch && batch.length === chunk.length) {
      chunk.forEach((path, index) => stats.set(path, batch?.[index] ?? null));
      continue;
    }
    // 单块失败（含某条非法路径）时逐条确认，保证其余条目仍能正确加入。
    for (const path of chunk) {
      stats.set(path, await statOne(stat, path));
    }
  }

  const inputs: TransferItemInput[] = [];
  const rejected: TransferRejection[] = [];
  for (const path of ordered) {
    const entry = stats.get(path) ?? null;
    if (!entry) {
      rejected.push(rejectionFor(path, "无法读取文件信息（路径无效或不可访问）"));
      continue;
    }
    const itemType = itemTypeForStat(entry);
    if (!itemType) {
      rejected.push(rejectionFor(path, "文件或目录不存在"));
      continue;
    }
    inputs.push({
      itemType,
      sourceModule,
      sourceId: path,
      title: basename(path),
      description: path,
      payload: { path, size: entry.size ?? undefined },
    });
  }
  return { inputs, rejected };
}
