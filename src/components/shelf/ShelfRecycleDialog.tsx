//! 外部文件拖入垃圾桶的确认框。
//!
//! 只做确认与结果说明：真正的校验/删除在 Rust（shelf::recycle），这里不拼接命令、
//! 不信任路径。确认前绝不删除；确认后被拒绝或指纹变化的条目逐项说明原因。

import { AlertTriangle, FileText, Folder } from "lucide-react";
import { Dialog } from "../ui";
import { formatBytes } from "../../lib/clipboardUi";
import type { ShelfRecyclePreview } from "../../lib/bridge";

export default function ShelfRecycleDialog({
  open,
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  preview: ShelfRecyclePreview | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ready = preview?.entries.filter((entry) => entry.status === "ready") ?? [];
  const blocked = preview?.entries.filter((entry) => entry.status === "blocked") ?? [];
  const dirs = ready.filter((entry) => entry.is_dir).length;
  const files = ready.length - dirs;

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onCancel}
      title="把这些文件移到回收站？"
      size="sm"
      dismissOnScrim={false}
      ariaLabel="确认移到回收站"
      footer={
        <>
          <button type="button" className="btn sm" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn sm danger"
            disabled={busy || ready.length === 0}
            onClick={onConfirm}
          >
            {busy ? "正在移入…" : `移到回收站（${ready.length} 项）`}
          </button>
        </>
      }
    >
      {!preview ? (
        <p className="shelf-recycle-hint" aria-live="polite">
          正在检查文件信息…
        </p>
      ) : (
        <div className="shelf-recycle">
          <p className="shelf-recycle-summary">
            {files > 0 && <span>{files} 个文件</span>}
            {files > 0 && dirs > 0 && <span aria-hidden="true">、</span>}
            {dirs > 0 && <span>{dirs} 个文件夹</span>}
            {ready.length > 0 && <span>，共 {formatBytes(preview.total_bytes)}</span>}
            {ready.length === 0 && <span>没有可安全删除的条目</span>}
          </p>
          <p className="shelf-recycle-note">
            使用 Windows 回收站删除，可在回收站恢复；Task Dock 不会永久删除，也不会触碰未列出的文件。
          </p>
          {ready.length > 0 && (
            <ul className="shelf-recycle-list" aria-label="将移入回收站的文件">
              {ready.slice(0, 12).map((entry) => (
                <li key={entry.path}>
                  {entry.is_dir ? (
                    <Folder size={13} aria-hidden="true" />
                  ) : (
                    <FileText size={13} aria-hidden="true" />
                  )}
                  <span className="shelf-recycle-name" title={entry.name}>
                    {entry.name}
                  </span>
                  <span className="shelf-recycle-size">{formatBytes(entry.byte_size)}</span>
                </li>
              ))}
              {ready.length > 12 && (
                <li className="shelf-recycle-more">另有 {ready.length - 12} 项…</li>
              )}
            </ul>
          )}
          {blocked.length > 0 && (
            <div className="shelf-recycle-blocked" role="alert">
              <div className="shelf-recycle-blocked-head">
                <AlertTriangle size={13} aria-hidden="true" />
                <span>{blocked.length} 项不会删除</span>
              </div>
              <ul>
                {blocked.slice(0, 8).map((entry) => (
                  <li key={entry.path}>
                    <span className="shelf-recycle-name" title={entry.name}>
                      {entry.name}
                    </span>
                    <span className="shelf-recycle-reason">{entry.reason ?? "无法安全删除"}</span>
                  </li>
                ))}
                {blocked.length > 8 && (
                  <li className="shelf-recycle-more">另有 {blocked.length - 8} 项…</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
