//! 真实卷缓存（第四轮 P0 补缺）。
//!
//! `defaultEffect()` 是同步纯函数，不能在每个 pointermove 上等 IPC；这里在
//! 目录打开/选择变化时预热，拖拽时只读缓存。缓存未命中返回 null，由调用方
//! 回退到盘符启发式；无法判定时宁可复制，绝不静默移动。

import { normalizePath } from "./pathUtils";

const cache = new Map<string, string | null>();
const pending = new Set<string>();

function keyOf(path: string): string {
  return normalizePath(path).toLowerCase();
}

/** 预热一批路径的卷键；失败静默（缓存保持未命中，不影响文件操作）。 */
export async function primeVolumeKeys(paths: string[]): Promise<void> {
  const fresh = Array.from(new Set(paths.map(keyOf).filter((p) => p && !cache.has(p) && !pending.has(p))));
  if (!fresh.length) return;
  for (const p of fresh) pending.add(p);
  try {
    const { fsVolumeKeys } = await import("../bridge");
    const keys = await fsVolumeKeys(fresh);
    fresh.forEach((p, i) => cache.set(p, keys[i] ?? null));
  } catch {
    // 后端不可用/路径暂时不可读：不写入 null，后续仍可重试。
  } finally {
    for (const p of fresh) pending.delete(p);
  }
}

/** 读取已预热的卷键；未命中返回 null。 */
export function cachedVolumeKey(path: string): string | null {
  return cache.get(keyOf(path)) ?? null;
}

/**
 * 只用真实卷缓存判断默认效果：
 * - 源与目标都已知 → 相同移动 / 不同复制；
 * - 任一未知 → null，调用方回退盘符启发式。
 */
export function volumeDecision(paths: string[], targetDir: string): "copy" | "move" | null {
  const first = paths[0];
  if (!first) return null;
  const source = cachedVolumeKey(first);
  const target = cachedVolumeKey(targetDir);
  if (!source || !target) return null;
  return source === target ? "move" : "copy";
}
