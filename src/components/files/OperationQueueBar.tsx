//! 文件操作队列条：统一展示「后端任务」与「前端 IPC 批次」两种来源。
//!
//! - 后端任务（`fsops`）有真实 `pending/running/cancelling/…` 与 `done/total`，
//!   可安全取消时提供取消按钮；
//! - 前端 IPC 批次（复制/移动/重命名）只有开始/结束两态、执行期不可取消，
//!   如实标注「后端无安全取消通道」。
//!
//! 两类条目共用同一组件与同一位置，不再为文件操作另建独立页面。

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { useLocale } from "../../hooks/useLocale";
import {
  QUEUE_CANCEL_SUPPORTED,
  subscribeQueue,
  type FileQueueEntry,
  type QueueEffect,
} from "../../lib/filesWorkspace/operationQueue";
import {
  cancelFileJob,
  subscribeFileJobs,
} from "../../lib/filesWorkspace/fileJobs";
import { isFileJobTerminal, type FileJobSnapshot } from "../../lib/bridge";

const EFFECT_KEY = {
  copy: "fw.queue.copy",
  move: "fw.queue.move",
  delete: "fw.queue.delete",
  deletePermanent: "fw.queue.deletePermanent",
  rename: "fw.queue.rename",
} as const satisfies Record<QueueEffect, string>;

const JOB_KIND_KEY = {
  copy: "fw.queue.copy",
  move: "fw.queue.move",
  rename: "fw.queue.rename",
  delete: "fw.queue.delete",
  delete_permanent: "fw.queue.deletePermanent",
  delete_duplicates: "fw.queue.deleteDuplicates",
  restore: "fw.queue.restore",
  purge: "fw.queue.purge",
  empty: "fw.queue.empty",
} as const satisfies Record<FileJobSnapshot["kind"], string>;

function jobTone(job: FileJobSnapshot): string {
  if (!isFileJobTerminal(job)) return " is-running";
  if (job.status === "failed") return " has-error";
  if (job.status === "partial") return " has-error";
  return "";
}

export default function OperationQueueBar() {
  const { t } = useLocale();
  const [entries, setEntries] = useState<FileQueueEntry[]>([]);
  const [jobs, setJobs] = useState<FileJobSnapshot[]>([]);

  useEffect(() => subscribeQueue(setEntries), []);
  useEffect(() => subscribeFileJobs(setJobs), []);

  // 同时执行的任务最多展示 2 个（与历史任务共享 2 行，优先活动任务）。
  const active = jobs.filter((job) => !isFileJobTerminal(job));
  const recent = jobs.filter(isFileJobTerminal).slice(0, 2);
  const visibleJobs = [...active, ...recent].slice(0, 2);
  const visibleLocal = entries.slice(-1).reverse();
  if (!visibleJobs.length && !visibleLocal.length) return null;

  return (
    <div className="fw-op-queue" role="status" aria-label={t("fw.queue.title")}>
      {visibleJobs.map((job) => {
        const remaining = Math.max(0, job.total - job.done);
        const terminal = isFileJobTerminal(job);
        const firstFailure = job.failures.find((entry) => entry.status !== "skipped");
        const statusText =
          job.status === "cancelling"
            ? t("fw.queue.cancelling")
            : job.status === "pending"
              ? t("fw.queue.pending")
              : null;
        return (
          <div key={job.id} className={`fw-op-queue-item${jobTone(job)}`}>
            {!terminal && job.status !== "cancelling" ? (
              <Loader2 size={12} className="fw-op-spinner" aria-hidden="true" />
            ) : job.status === "failed" || job.status === "partial" ? (
              <AlertTriangle
                size={12}
                aria-hidden="true"
                {...(firstFailure?.message
                  ? { "data-tip": firstFailure.message }
                  : {})}
              />
            ) : null}
            <span className="fw-op-name">{t(JOB_KIND_KEY[job.kind])}</span>
            <span className="fw-op-count">
              {t("fw.queue.progress", { completed: job.done, total: job.total })}
            </span>
            <span className="fw-op-detail">
              {job.partial > 0
                ? t("fw.queue.detailPartial", {
                    failed: job.failed,
                    partial: job.partial,
                    skipped: job.skipped,
                    remaining,
                  })
                : t("fw.queue.detail", {
                    failed: job.failed,
                    skipped: job.skipped,
                    remaining,
                  })}
            </span>
            {statusText && <span className="fw-op-state">{statusText}</span>}
            {!terminal && job.cancelable && !job.cancelRequested && job.status !== "cancelling" ? (
              <button
                type="button"
                className="fw-op-cancel"
                aria-label={t("fw.queue.cancel")}
                data-tip={t("fw.queue.cancel")}
                onClick={() => void cancelFileJob(job.id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
            {!terminal && (!job.cancelable || job.cancelRequested || job.status === "cancelling") ? (
              <span className="fw-op-no-cancel">
                {job.status === "cancelling" || job.cancelRequested
                  ? t("fw.queue.cancelling")
                  : t("fw.queue.cancelUnsupported")}
              </span>
            ) : null}
          </div>
        );
      })}
      {visibleLocal.map((entry) => {
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
