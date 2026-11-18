//! 跨目录文件传输的共享语义：冲突预检、批量决策、目标路径与成功项选择更新。
//!
//! 真实文件操作走 `fsCopyJobStart` / `fsMoveJobStart` 任务服务；本模块不复制后端实现，
//! 只把「前端需要知道什么」收敛成可测试的纯逻辑。

import { fsStat, type FsOpReport } from "../bridge";
import { basename, joinPath, normalizePath, parentOf, samePath } from "./pathUtils";
import { validateFileDrop } from "./interactions";

export type TransferEffect = "copy" | "move";

/** 与 Rust `parse_conflict` 的允许值一致；UI 文案映射由组件层负责。 */
export type ConflictStrategy = "rename" | "skip" | "overwrite";

export interface TransferConflict {
  source: string;
  target: string;
  targetKind: "dir" | "file" | "link" | "missing";
}

/**
 * 过滤掉「源已经在目标目录」的路径：拖回当前目录没有语义，绝不能变成原地复制。
 * 合法路径仍交给 `validateFileDrop` 做子树/自身检查。
 */
export function filterTransferablePaths(paths: string[], targetDir: string): string[] {
  return paths.filter((path) => {
    if (validateFileDrop([path], targetDir) !== targetDir) return false;
    return !samePath(parentOf(path) ?? "", targetDir);
  });
}

/** 目标目录中的同名项（批量操作只弹一次；全部应用同一策略）。 */
export async function detectTransferConflicts(
  paths: string[],
  targetDir: string,
): Promise<TransferConflict[]> {
  const accepted = filterTransferablePaths(paths, targetDir);
  if (!accepted.length) return [];
  const targets = accepted.map((path) => joinPath(targetDir, basename(path)));
  const stats: Awaited<ReturnType<typeof fsStat>> = [];
  // fs_stat 单批有上限；按 100 分批，避免大选择时冲突预检直接失败。
  for (let index = 0; index < targets.length; index += 100) {
    stats.push(...(await fsStat(targets.slice(index, index + 100))));
  }
  const byPath = new Map(stats.map((stat) => [normalizePath(stat.path).toLowerCase(), stat]));
  const out: TransferConflict[] = [];
  accepted.forEach((source, index) => {
    const target = targets[index];
    const stat = byPath.get(normalizePath(target).toLowerCase());
    if (stat?.exists) {
      out.push({
        source,
        target,
        targetKind: stat.kind === "dir" || stat.kind === "file" || stat.kind === "link" ? stat.kind : "missing",
      });
    }
  });
  return out;
}

/** 移动成功后要从来源选择中移除的路径：只认后端报告 `ok`，partial/failed 源仍在。 */
export function movedSourcesToClear(report: FsOpReport | null): string[] {
  if (!report) return [];
  return report.entries
    .filter((entry) => entry.status === "ok")
    .map((entry) => entry.source)
    .filter(Boolean);
}

/**
 * 传输结束后仍需保留的源路径：**只移除报告明确 `ok` 的项**。
 *
 * 取消/部分完成时，未处理项不在报告里；报告缺失时无法判断任何一项，因此保留全部。
 * 这条规则同时守护移动后的选择与内部剪切板，避免把「未执行」误当成「已完成」。
 */
export function remainingSourcesAfterTransfer(
  report: FsOpReport | null,
  originalPaths: string[],
): string[] {
  if (!report) return [...originalPaths];
  const done = new Set(
    report.entries
      .filter((entry) => entry.status === "ok")
      .map((entry) => normalizePath(entry.source).toLowerCase()),
  );
  return originalPaths.filter((path) => !done.has(normalizePath(path).toLowerCase()));
}

/** 操作后需要失效的目录：目标目录 + 所有成功迁移项的父目录（失败源目录也刷新更安全）。 */
export function transferRefreshDirs(paths: string[], targetDir: string): string[] {
  const dirs = new Set<string>([targetDir]);
  for (const path of paths) {
    const parent = parentOf(path);
    if (parent) dirs.add(parent);
  }
  return [...dirs];
}

/** 目标窗格列表项（用于快速传输选择器）。 */
export interface TransferTarget {
  paneId: string;
  label: string;
  dir: string;
  active: boolean;
}

/** F5/F6 目标规则：两窗格自动另一个；多窗格优先上次目标；否则需要用户选择。 */
export function pickAutomaticTarget(input: {
  sourcePaneId: string;
  paneIds: string[];
  lastTargetPaneId: string | null;
}): { paneId: string | null; needsPicker: boolean } {
  const others = input.paneIds.filter((id) => id !== input.sourcePaneId);
  if (others.length === 0) return { paneId: null, needsPicker: false };
  if (others.length === 1) return { paneId: others[0], needsPicker: false };
  if (input.lastTargetPaneId && others.includes(input.lastTargetPaneId)) {
    return { paneId: input.lastTargetPaneId, needsPicker: false };
  }
  return { paneId: null, needsPicker: true };
}
