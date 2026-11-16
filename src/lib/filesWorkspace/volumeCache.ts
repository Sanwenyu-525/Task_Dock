//! 真实卷缓存（第四轮 P0 补缺，第五轮安全默认修正）。
//!
//! `defaultEffect()` 是同步纯函数，不能在每个 pointermove 上等 IPC；这里在
//! 目录打开/选择变化时预热，拖拽时只读缓存。缓存未命中返回 null，调用方
//! **必须按复制处理**——盘符相同不足以证明同卷，绝不能静默移动。

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
    fresh.forEach((p, i) => {
      const key = keys[i] ?? null;
      // 查询失败不缓存 null，否则后续拖拽无法重新预热，只能永久按复制。
      if (key) cache.set(p, key);
      else cache.delete(p);
    });
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

/** 测试与目录/挂载变化时使用：丢弃指定路径（不传则全清）的缓存。 */
export function invalidateVolumeCache(paths?: string[]): void {
  if (!paths?.length) {
    cache.clear();
    pending.clear();
    return;
  }
  for (const path of paths) cache.delete(keyOf(path));
}

/**
 * 只用真实卷缓存判断默认效果：
 * - 所有源与目标都已知，且全部源同卷 → 移动；
 * - 任一源与目标不同卷 → 复制；
 * - 任一源/目标未知 → null，调用方按复制处理（安全默认）。
 */
export function volumeDecision(paths: string[], targetDir: string): "copy" | "move" | null {
  if (!paths.length) return null;
  const target = cachedVolumeKey(targetDir);
  if (!target) return null;
  const sources = paths.map(cachedVolumeKey);
  if (sources.some((source) => !source)) return null;
  return sources.every((source) => source === target) ? "move" : "copy";
}
