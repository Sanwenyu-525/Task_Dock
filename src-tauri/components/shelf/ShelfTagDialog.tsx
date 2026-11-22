//! 批量标签：添加/移除，最近标签一键复用。
//!
//! 只写标签关系，不移动文件、不改分组；超限或重复以计数反馈。

import { useEffect, useState } from "react";
import { Loader2, Tag } from "lucide-react";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";
import { errorMessage } from "../../lib/errors";
import type { ShelfTagChangeReport } from "../../lib/bridge";
import { Dialog } from "../ui/Dialog";

export interface ShelfTagDialogProps {
  open: boolean;
  ids: string[];
  onClose: () => void;
  onDone?: (report: ShelfTagChangeReport) => void;
}

/** 逗号/顿号/空白分隔；保留原文，最终由后端规范化校验。 */
export function splitTagInput(raw: string): string[] {
  return raw
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export default function ShelfTagDialog({ open, ids, onClose, onDone }: ShelfTagDialogProps) {
  const showToast = useUiStore((s) => s.showToast);
  const tagItems = useShelfStore((s) => s.tagItems);
  const recentTags = useShelfStore((s) => s.recentTags);
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [input, setInput] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [recentError, setRecentError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode("add");
    setInput("");
    setRecentError("");
    let alive = true;
    recentTags(12)
      .then((tags) => {
        if (alive) setRecent(tags.map((t) => t.tag));
      })
      .catch((e) => {
        if (alive) setRecentError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [open, recentTags]);

  const tags = splitTagInput(input);

  const submit = async () => {
    if (busy || tags.length === 0) return;
    setBusy(true);
    try {
      const report = await tagItems(ids, tags, mode);
      const verb = mode === "add" ? "添加" : "移除";
      if (report.success) {
        const extra: string[] = [];
        if (report.skipped > 0) extra.push(`${report.skipped} 项已存在或超出上限`);
        if (report.failed.length > 0) extra.push(`${report.failed.length} 项失败`);
        showToast(
          `已为 ${report.items} 项${verb}标签${extra.length ? `（${extra.join("，")}）` : ""}`,
          {
            kind: report.partial ? "warning" : "success",
            detail:
              report.failed.length > 0
                ? report.failed.map((f) => f.reason).slice(0, 3).join("；")
                : undefined,
          },
        );
        onDone?.(report);
        onClose();
      } else {
        showToast(
          mode === "add" ? "标签未变化：这些条目已包含所选标签" : "没有可移除的标签",
          { kind: "warning", code: report.code ?? undefined },
        );
      }
    } catch (e) {
      showToast(`标签操作失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="批量标签"
      size="sm"
      ariaLabel="批量添加或移除标签"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy || tags.length === 0}
          >
            {busy ? (
              <Loader2 size={14} className="spin" aria-hidden="true" />
            ) : (
              <Tag size={14} aria-hidden="true" />
            )}
            {mode === "add" ? "添加标签" : "移除标签"}
          </button>
        </>
      }
    >
      <div className="shelf-batch-link">
        <div className="shelf-batch-link-mode" role="group" aria-label="标签操作类型">
          <button
            type="button"
            className={`btn sm${mode === "add" ? " primary" : ""}`}
            aria-pressed={mode === "add"}
            onClick={() => setMode("add")}
          >
            添加
          </button>
          <button
            type="button"
            className={`btn sm${mode === "remove" ? " primary" : ""}`}
            aria-pressed={mode === "remove"}
            onClick={() => setMode("remove")}
          >
            移除
          </button>
        </div>
        <input
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入标签，用空格或逗号分隔"
          aria-label="标签内容"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {recent.length > 0 && (
          <div className="shelf-tag-recent" aria-label="最近使用的标签">
            <span className="shelf-tag-recent-label">最近：</span>
            {recent.map((tag) => (
              <button
                key={tag}
                type="button"
                className="shelf-tag-chip"
                onClick={() =>
                  setInput((prev) => {
                    const parts = splitTagInput(prev);
                    return parts.includes(tag) ? prev : [...parts, tag].join(" ");
                  })
                }
              >
                {tag}
              </button>
            ))}
          </div>
        )}
        {recentError && (
          <p className="shelf-links-status is-error" role="alert">
            最近标签加载失败：{recentError}
          </p>
        )}
        <p className="shelf-batch-link-hint">
          将为选中的 {ids.length} 项{mode === "add" ? "添加" : "移除"}标签；不移动文件、不改动分组。
        </p>
      </div>
    </Dialog>
  );
}
