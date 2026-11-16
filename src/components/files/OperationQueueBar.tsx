//! 文件操作队列条：显示真实总数/完成/失败/跳过/剩余，并明确后端能否安全取消。

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useLocale } from "../../hooks/useLocale";
import {
  QUEUE_CANCEL_SUPPORTED,
  subscribeQueue,
  type FileQueueEntry,
  type QueueEffect,
} from "../../lib/filesWorkspace/operationQueue";

const EFFECT_KEY: Record<QueueEffect, string> = {
  copy: "fw.queue.copy",
  move: "fw.queue.move",
  delete: "fw.queue.delete",
  deletePermanent: "fw.queue.deletePermanent",
  rename: "fw.queue.rename",
};

export default function OperationQueueBar() {
  const { t } = useLocale();
  const [entries, setEntries] = useState<FileQueueEntry[]>([]);
  useEffect(() => subscribeQueue(setEntries), []);
  if (!entries.length) return null;
  const visible = entries.slice(-2).reverse();
  return (
    <div className="fw-op-queue" role="status" aria-label={t("fw.queue.title")}>
      {visible.map((entry) => {
        const completed = entry.ok + entry.failed + entry.skipped + entry.partial;
        const remaining = Math.max(0, entry.total - completed);
        return (
          <div
            key={entry.id}
            className={`fw-op-queue-item${entry.status === "running" ? " is-running" : ""}${entry.failed > 0 || entry.status === "failed" ? " has-error" : ""}`}
          >
            {entry.status === "running" ? (
              <Loader2 size={12} className="fw-op-spinner" aria-hidden="true" />
            ) : entry.failed > 0 || entry.status === "failed" ? (
              <AlertTriangle size={12} aria-hidden="true" />
            ) : null}
            <span className="fw-op-name">{t(EFFECT_KEY[entry.effect])}</span>
            <span className="fw-op-count">
              {t("fw.queue.progress", {
                completed: entry.status === "running" ? 0 : completed,
                total: entry.total,
              })}
            </span>
            <span className="fw-op-detail">
              {t("fw.queue.detail", {
                failed: entry.failed,
                skipped: entry.skipped,
                remaining: entry.status === "running" ? remaining : 0,
              })}
            </span>
            {entry.status === "running" && !QUEUE_CANCEL_SUPPORTED && (
              <span className="fw-op-no-cancel">{t("fw.queue.cancelUnsupported")}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
