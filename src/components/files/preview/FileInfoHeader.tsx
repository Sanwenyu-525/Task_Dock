//! 文件信息头部（弹窗与右侧检查器共用的唯一实现）。
//!
//! 展示顺序固定：类型图标 → 完整文件名（超长截断 + 悬停全文）→ 类型标签 →
//! 扩展名 → 大小 / 修改时间 / 所在目录。图标与标签颜色来自 `fileVisuals`
//! 的 tone，不再让所有类型共用同一种灰色。

import type { FsEntry } from "../../../lib/bridge";
import { formatModified, formatSize } from "../../../lib/filesWorkspace/fileMeta";
import { extOf } from "./previewKind";
import { fileVisual } from "./fileVisuals";

export interface FileInfoHeaderProps {
  entry: FsEntry;
  path: string;
  variant?: "dialog" | "panel";
  /** 所在目录（弹窗显示；面板在标题下方显示完整路径）。 */
  dir?: string;
}

export default function FileInfoHeader({ entry, path, variant = "dialog", dir }: FileInfoHeaderProps) {
  const visual = fileVisual(entry);
  const ext = extOf(entry.name);
  const folder = entry.kind === "dir";
  return (
    <div className="fw-file-head" data-tone={visual.tone} data-variant={variant}>
      <span className="fw-file-head-icon" aria-hidden="true">
        <visual.Icon size={variant === "panel" ? 16 : 20} strokeWidth={1.7} />
      </span>
      <div className="fw-file-head-main">
        <div className="fw-file-head-title">
          <span className="fw-file-head-name" title={entry.name}>
            {entry.name}
          </span>
          <span className="fw-file-chip" data-tone={visual.tone}>
            {visual.label}
          </span>
          {ext && !folder ? <span className="fw-file-chip is-quiet">.{ext}</span> : null}
        </div>
        <div className="fw-file-head-meta">
          {/* 大小 · 修改时间（弹窗再追加所在目录）包成一组：面板里整体占一行，
              不会被逐项换行拆成「大小 / · / 时间」三行、也不会只剩一个孤立的分隔点。 */}
          <span className="fw-file-head-facts">
            <span>{formatSize(entry.size)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatModified(entry.modifiedMs)}</span>
            {variant === "dialog" && dir ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="fw-file-head-dir" title={dir}>
                  {dir}
                </span>
              </>
            ) : null}
          </span>
          {variant === "panel" ? (
            <span className="fw-file-head-path" title={path}>
              {path}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
