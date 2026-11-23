//! 选择 → 右侧预览目标的纯函数（不读文件、不写 Store）。
//!
//! 权威来源仍是 `useFilesWorkspaceStore.selection`：这里只把「当前窗格选中的
//! 路径」映射成预览目标。多选 / 无选择返回 `null`（由检查器显示统计或空态），
//! 不对第一个文件做隐式预览。

import type { FsEntry } from "../bridge";
import { joinPath, samePath } from "./pathUtils";

export interface FilePreviewTarget {
  paneId: string;
  path: string;
  dir: string;
  name: string;
  size: number | null;
  entry: FsEntry;
}

export interface PreviewSelectionSummary {
  /** 选中项总数（含被筛选隐藏的项，这是用户真实选择）。 */
  count: number;
  files: number;
  dirs: number;
  /** 可见选中项的大小合计（不可见项无法安全统计，不估算）。 */
  bytes: number;
  /** 单选文件夹时给出身份信息（不递归统计子目录内容）。 */
  folder: { path: string; name: string; entry: FsEntry } | null;
}

export interface PreviewSelectionSnapshot {
  paneId: string;
  dir: string;
  target: FilePreviewTarget | null;
  summary: PreviewSelectionSummary;
}

const EMPTY_SUMMARY: PreviewSelectionSummary = { count: 0, files: 0, dirs: 0, bytes: 0, folder: null };

/**
 * 单选文件 → 预览目标；多选、无选择、选中的是文件夹、或选中项已被筛选隐藏
 * 时返回 `null`。路径比较走 `samePath`（Windows 大小写不敏感）。
 */
export function resolvePreviewSelection(
  selectedPaths: readonly string[],
  visibleEntries: readonly FsEntry[],
  paneId: string,
  dirPath: string,
): FilePreviewTarget | null {
  if (selectedPaths.length !== 1) return null;
  const wanted = selectedPaths[0];
  const entry = visibleEntries.find(
    (candidate) => candidate.kind !== "dir" && samePath(joinPath(dirPath, candidate.name), wanted),
  );
  if (!entry) return null;
  return {
    paneId,
    path: joinPath(dirPath, entry.name),
    dir: dirPath,
    name: entry.name,
    size: entry.size,
    entry,
  };
}

/** 选择统计：多选摘要与「单选文件夹」身份都从这里取。 */
export function summarizePreviewSelection(
  selectedPaths: readonly string[],
  visibleEntries: readonly FsEntry[],
  dirPath: string,
): PreviewSelectionSummary {
  if (selectedPaths.length === 0) return EMPTY_SUMMARY;
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  let folder: PreviewSelectionSummary["folder"] = null;

  for (const path of selectedPaths) {
    const entry = visibleEntries.find((candidate) => samePath(joinPath(dirPath, candidate.name), path));
    if (!entry) continue;
    if (entry.kind === "dir") {
      dirs += 1;
      if (selectedPaths.length === 1) folder = { path, name: entry.name, entry };
    } else {
      files += 1;
      bytes += entry.size ?? 0;
    }
  }

  return { count: selectedPaths.length, files, dirs, bytes, folder };
}

/** 一次选择变化的完整快照（FilePane → FilesWorkspacePanel）。 */
export function buildPreviewSelection(
  selectedPaths: readonly string[],
  visibleEntries: readonly FsEntry[],
  paneId: string,
  dirPath: string,
): PreviewSelectionSnapshot {
  return {
    paneId,
    dir: dirPath,
    target: resolvePreviewSelection(selectedPaths, visibleEntries, paneId, dirPath),
    summary: summarizePreviewSelection(selectedPaths, visibleEntries, dirPath),
  };
}

export function emptyPreviewSelection(paneId: string, dir: string): PreviewSelectionSnapshot {
  return { paneId, dir, target: null, summary: EMPTY_SUMMARY };
}
