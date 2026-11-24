//! 预览版本（revision）：同一路径在磁盘上变化时，用来区分「新旧内容」的最小标识。
//!
//! 为什么需要：右侧检查器与弹窗都按**路径**复用预览组件，文件在原地被外部程序改写
//! （保存、下载覆盖、剪贴板落地）后路径不变，仅靠 path 无法触发刷新，会继续显示旧正文。
//!
//! 版本只取 `FsEntry` 已有的两个轻量字段（目录列表本来就会返回，无额外 IPC）：
//! - `size`：内容长度变化（最常见）；
//! - `modifiedMs`：同长度覆盖（例如只改一个字符）会更新 mtime。
//!
//! 明确限制（不假装完全可靠）：部分文件系统 mtime 精度较粗（FAT 2s / 网络盘 1s），
//! 在**同一时间粒度内**做「等长改写」时两个字段都不变，此时 revision 判定为未变化，
//! 预览不会自动刷新。可用的显式刷新路径：目录工具栏刷新后重新选择文件，或关闭再
//! 打开检查器（重挂载即重新读盘）。目录轮询只有签名变化才会重拉列表，仍不额外轮询。

import type { FsEntry } from "../bridge";
import { normalizePath } from "./pathUtils";

export interface PreviewRevision {
  path: string;
  size: number | null;
  modifiedMs: number | null;
}

type RevisionSource = Pick<FsEntry, "size" | "modifiedMs">;

/** 由目录条目构造版本标识（不访问文件系统）。 */
export function revisionOf(path: string, entry: RevisionSource): PreviewRevision {
  return { path, size: entry.size ?? null, modifiedMs: entry.modifiedMs ?? null };
}

/**
 * 版本键：可安全用于 React `key`、effect 依赖与去重签名。
 * 路径按 Windows 规则小写归一；缺失字段用 `-` 占位，避免 `null` 与 `0` 混淆。
 */
export function revisionKey(revision: PreviewRevision | null | undefined): string {
  if (!revision) return "";
  const path = normalizePath(revision.path).toLowerCase();
  const size = revision.size === null ? "-" : String(revision.size);
  const modified = revision.modifiedMs === null ? "-" : String(revision.modifiedMs);
  return `${path}|${size}|${modified}`;
}

/** 两个版本是否指向「同一路径的不同内容」。 */
export function revisionChanged(
  previous: PreviewRevision | null | undefined,
  next: PreviewRevision | null | undefined,
): boolean {
  return revisionKey(previous) !== revisionKey(next);
}
