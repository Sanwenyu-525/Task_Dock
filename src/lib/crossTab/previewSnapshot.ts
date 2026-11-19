//! 发送预览参数快照：保证「预览用 A 参数、执行用 B 参数」不可能发生。
//!
//! 规则：
//! - 预览成功时记录选择集、目标、选项与版本号；
//! - 任一参数变化（包括顺序变化无关，选择按集合比较）都使快照失效；
//! - 只有当前参数与快照完全一致时才允许确认执行；
//! - 重新预览必须重新校验目标（目标目录可能被删除/改名）。

import type { TransferOptions, TransferTarget } from "./types";

export interface PreviewSnapshot {
  version: number;
  /** 排序去重后的条目 id：只比较集合，不比较点击顺序。 */
  itemIds: string[];
  targetModule: string;
  targetRef: string;
  options: TransferOptions;
  previewedAt: number;
}

export interface PreviewParams {
  ids: string[];
  target: TransferTarget;
  options: TransferOptions;
}

const OPTION_KEYS: Array<keyof TransferOptions> = [
  "conflict",
  "textFormat",
  "textMode",
  "fileOperation",
  "urlMode",
  "sentRetentionDays",
];

export function selectionKey(ids: string[]): string {
  return [...new Set(ids)].sort().join("\u0001");
}

/** 只比较已知选项字段，忽略前端临时附加属性。 */
export function optionsKey(options: TransferOptions): string {
  return OPTION_KEYS.map((key) => `${key}=${String(options[key] ?? "")}`).join("&");
}

export function createSnapshot(params: PreviewParams, version: number): PreviewSnapshot {
  return {
    version,
    itemIds: [...new Set(params.ids)].sort(),
    targetModule: params.target.module,
    targetRef: params.target.ref.trim(),
    options: { ...params.options },
    previewedAt: Date.now(),
  };
}

/** 当前参数是否仍与快照一致（完全一致才允许执行）。 */
export function snapshotMatches(snapshot: PreviewSnapshot | null, params: PreviewParams): boolean {
  if (!snapshot) return false;
  if (selectionKey(snapshot.itemIds) !== selectionKey(params.ids)) return false;
  if (snapshot.targetModule !== params.target.module) return false;
  if (snapshot.targetRef !== params.target.ref.trim()) return false;
  return optionsKey(snapshot.options) === optionsKey(params.options);
}

/** 哪些参数变化导致预览失效（用于 UI 提示，不参与判定）。 */
export function changedFields(snapshot: PreviewSnapshot | null, params: PreviewParams): string[] {
  if (!snapshot) return [];
  const changed: string[] = [];
  if (selectionKey(snapshot.itemIds) !== selectionKey(params.ids)) changed.push("selection");
  if (snapshot.targetModule !== params.target.module || snapshot.targetRef !== params.target.ref.trim()) {
    changed.push("target");
  }
  for (const key of OPTION_KEYS) {
    if (snapshot.options[key] !== params.options[key]) changed.push(key);
  }
  return changed;
}
