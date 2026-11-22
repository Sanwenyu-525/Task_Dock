//! 重复内容检测结果：同内容 / 同路径 / 相似图片 / 同名不同内容。
//!
//! 只提示，不提供「一键合并/删除」：来源不同的相同内容可能都需要保留。

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useShelfStore } from "../../store/useShelfStore";
import { errorMessage } from "../../lib/errors";
import { formatBytes } from "../../lib/clipboardUi";
import type { ShelfDedupGroup, ShelfDedupReport } from "../../lib/bridge";
import { Dialog } from "../ui/Dialog";

export const DEDUP_KIND_LABELS: Record<ShelfDedupGroup["kind"], string> = {
  exact: "内容完全相同",
  same_path: "相同原始路径",
  similar_image: "相似图片",
  same_name: "同名不同内容",
};

export interface ShelfDuplicateDialogProps {
  open: boolean;
  /** 为空时扫描最近 500 条（全库检测）。 */
  ids?: string[];
  onClose: () => void;
}

export default function ShelfDuplicateDialog({ open, ids, onClose }: ShelfDuplicateDialogProps) {
  const scanDuplicates = useShelfStore((s) => s.scanDuplicates);
  const [report, setReport] = useState<ShelfDedupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setReport(await scanDuplicates(ids));
    } catch (e) {
      setError(errorMessage(e));
      setReport(null);
    } finally {
      setBusy(false);
    }
  }, [ids, scanDuplicates]);

  useEffect(() => {
    if (!open) return;
    setReport(null);
    void run();
  }, [open, run]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="重复内容检测"
      size="lg"
      ariaLabel="重复内容检测结果"
      footer={
        <>
          <button type="button" className="btn" onClick={() => void run()} disabled={busy}>
            <RefreshCw size={14} aria-hidden="true" /> 重新检测
          </button>
          <button type="button" className="btn primary" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </>
      }
    >
      <div className="shelf-dedup">
        {busy && (
          <p className="shelf-links-status" role="status">
            <Loader2 size={14} className="spin" aria-hidden="true" /> 正在计算内容指纹…
          </p>
        )}
        {error && (
          <p className="shelf-links-status is-error" role="alert">
            检测失败：{error}
          </p>
        )}
        {!busy && report && (
          <>
            <p className="shelf-batch-link-hint">
              已检测 {report.scanned} 项，其中 {report.hashed} 项可计算内容指纹。检测只做提示，
              不会自动合并或删除任何条目。
            </p>
            {report.groups.length === 0 ? (
              <p className="shelf-links-empty">未发现重复内容</p>
            ) : (
              <ul className="shelf-dedup-groups">
                {report.groups.map((group, gi) => (
                  <li key={`${group.kind}-${group.key}-${gi}`} className="shelf-dedup-group">
                    <div className="shelf-dedup-head">
                      <span className={`shelf-dedup-kind is-${group.kind}`}>
                        {DEDUP_KIND_LABELS[group.kind]}
                      </span>
                      <span className="shelf-dedup-count">{group.items.length} 项</span>
                    </div>
                    <ul className="shelf-dedup-items">
                      {group.items.map((item) => (
                        <li key={item.id}>
                          <span className="shelf-dedup-name" title={item.display_name}>
                            {item.display_name}
                          </span>
                          <span className="shelf-dedup-meta">
                            {item.kind} · {formatBytes(item.byte_size)}
                          </span>
                          {item.original_path && (
                            <span className="shelf-dedup-path" title={item.original_path}>
                              {item.original_path}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            {report.truncated && (
              <p className="shelf-links-status">重复组过多，仅展示前 {report.groups.length} 组。</p>
            )}
            {report.unreadable.length > 0 && (
              <p className="shelf-links-status">
                {report.unreadable.length} 项内容暂时无法读取，仅参与路径/同名判断。
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
