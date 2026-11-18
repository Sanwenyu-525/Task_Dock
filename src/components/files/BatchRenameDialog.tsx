//! 批量重命名对话框：实时预览 -> 非法名/重复/已存在目标拦截 -> 后端逐项执行。

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Checkbox } from "../ui";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import {
  buildBatchRenamePreview,
  DEFAULT_BATCH_RENAME_OPTIONS,
  type BatchRenameMode,
  type BatchRenameOptions,
  type BatchRenamePreviewItem,
} from "../../lib/filesWorkspace/batchRename";
import {
  fsBatchRenameJobStart,
  fsStat,
  isFileJobTerminal,
  type FileJobSnapshot,
  type FsOpReport,
} from "../../lib/bridge";
import { invalidateDirs } from "../../lib/filesWorkspace/dirCache";
import { parentOf } from "../../lib/filesWorkspace/pathUtils";
import { remainingSourcesAfterTransfer } from "../../lib/filesWorkspace/transfer";
import { withFileOperationSlot } from "../../lib/filesWorkspace/operationQueue";
import {
  cancelFileJob,
  finishFileJob,
  registerFileJob,
} from "../../lib/filesWorkspace/fileJobs";
import { startOperation } from "../../lib/diagnostics";
import { errorMessage } from "../../lib/errors";

export interface BatchRenameRequest {
  paneId: string;
  paths: string[];
}

interface Props {
  request: BatchRenameRequest | null;
  onClose: () => void;
}

const MODES: BatchRenameMode[] = ["prefix", "suffix", "replace", "delete", "sequence", "lower", "upper"];

export default function BatchRenameDialog({ request, onClose }: Props) {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const [options, setOptions] = useState<BatchRenameOptions>(DEFAULT_BATCH_RENAME_OPTIONS);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<FsOpReport | null>(null);
  /** 仍需处理的原始路径：只移除报告明确成功的项；取消/失败的项留在编辑列表。 */
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  /** 本次实际提交的路径（展示「未处理」需要原始清单）。 */
  const [attemptedPaths, setAttemptedPaths] = useState<string[]>([]);
  const [job, setJob] = useState<FileJobSnapshot | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  useEffect(() => {
    if (request) {
      setOptions(DEFAULT_BATCH_RENAME_OPTIONS);
      setExisting(new Set());
      setRunning(false);
      setResult(null);
      setPendingPaths([...request.paths]);
      setAttemptedPaths([]);
      setJob(null);
      setCancelBusy(false);
    }
  }, [request]);

  // 先按“无已存在”生成目标，再只读 fs_stat 目标路径；不改文件，不后台扫目录。
  const basePreview = useMemo(
    () => (request ? buildBatchRenamePreview(pendingPaths, options, existing) : []),
    [request, pendingPaths, options, existing],
  );

  useEffect(() => {
    if (!request || pendingPaths.length === 0) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const targets = buildBatchRenamePreview(pendingPaths, options, []).map((item) => item.target);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const found: string[] = [];
          for (let index = 0; index < targets.length && index < 500; index += 100) {
            const batch = targets.slice(index, index + 100);
            const stats = await fsStat(batch);
            for (const stat of stats) if (stat.exists) found.push(stat.path);
          }
          if (!cancelled) setExisting(new Set(found.map((path) => path.toLocaleLowerCase())));
        } catch {
          // 预检失败不阻止预览；执行时后端仍会拒绝冲突，错误会在结果中明确返回。
        } finally {
          if (!cancelled) setChecking(false);
        }
      })();
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [request, pendingPaths, options]);

  if (!request) return null;

  const invalid = basePreview.filter((item) => item.status === "invalid");
  const conflicts = basePreview.filter((item) => item.status === "conflict");
  const unchanged = basePreview.filter((item) => item.status === "unchanged");
  const executable = basePreview.filter((item) => item.status === "ok");
  const blocked = invalid.length > 0 || conflicts.length > 0 || pendingPaths.length > 500;
  const previewLimited = basePreview.slice(0, 200);

  const update = (patch: Partial<BatchRenameOptions>) => setOptions((prev) => ({ ...prev, ...patch }));

  const execute = async () => {
    if (blocked || !executable.length || running) return;
    const allPaths = [...pendingPaths];
    const targets = executable.map((item) => item.path);
    setAttemptedPaths(targets);
    setRunning(true);
    setResult(null);
    setJob(null);
    const op = startOperation("file", "workspace_batch_rename", {
      component: "文件工作区",
      metadata: { count: executable.length },
    });
    try {
      op.stage("job");
      const initial = await withFileOperationSlot(() =>
        fsBatchRenameJobStart(
          executable.map((item) => ({ path: item.path, newName: item.newName })),
          op.id,
        ),
      );
      registerFileJob(initial);
      setJob(initial);
      const { job: final, report } = await finishFileJob(initial.id);
      if (final) setJob(final);
      const dirs = [...new Set(executable.map((item) => parentOf(item.path) ?? "").filter(Boolean))];
      invalidateDirs(dirs);
      if (!final) {
        showToast(t("fw.queue.jobLost"), { kind: "warning" });
        return;
      }
      if (final.status === "cancelled" || final.status === "cancelling") {
        // 取消后只移除报告明确成功的项；未处理/失败项仍留在编辑列表。
        const remaining = remainingSourcesAfterTransfer(report, allPaths);
        if (report) setResult(report);
        setPendingPaths(remaining);
        showToast(t("fw.batch.cancelled", { ok: final.ok, remaining: remaining.length }), {
          kind: "warning",
        });
        return;
      }
      if (!report) {
        // 计数已确认但逐项结果不可读：不移除任何行，避免把未执行项当成成功。
        showToast(t("fw.batch.reportUnavailable", {
          ok: final.ok,
          failed: final.failed,
          skipped: final.skipped,
        }), { kind: "warning" });
        return;
      }
      setResult(report);
      const remaining = remainingSourcesAfterTransfer(report, allPaths);
      setPendingPaths(remaining);
      const incomplete = report.failed > 0 || report.partial > 0 || report.skipped > 0 || remaining.length > 0;
      showToast(
        t("fw.batch.result", { ok: report.ok, failed: report.failed, skipped: report.skipped }),
        { kind: incomplete ? "warning" : "success" },
      );
      if (!incomplete) onClose();
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    } finally {
      setRunning(false);
    }
  };

  const requestCancel = async () => {
    if (!job || isFileJobTerminal(job) || job.cancelRequested || cancelBusy) return;
    setCancelBusy(true);
    try {
      const effective = await cancelFileJob(job.id);
      if (!effective) {
        showToast(t("fw.queue.cancelNotEffective"), { kind: "warning" });
      } else {
        setJob((prev) => (prev ? { ...prev, cancelRequested: true } : prev));
      }
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    } finally {
      setCancelBusy(false);
    }
  };

  const statusLabel = (item: BatchRenamePreviewItem) => {
    if (item.status === "invalid") return t("fw.batch.statusInvalid");
    if (item.status === "conflict") return t("fw.batch.statusConflict");
    if (item.status === "unchanged") return t("fw.batch.statusUnchanged");
    return t("fw.batch.statusOk");
  };

  const basenameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const resultStatusLabel = (status: string) => {
    if (status === "ok") return t("fw.batch.resultOk");
    if (status === "partial") return t("fw.batch.resultPartial");
    if (status === "skipped") return t("fw.batch.resultSkipped");
    return t("fw.batch.resultFailedStatus");
  };
  const resultEntries = result?.entries.slice(0, 100) ?? [];
  const reportedSources = new Set((result?.entries ?? []).map((entry) => entry.source.toLowerCase()));
  const unprocessed = result
    ? attemptedPaths.filter((path) => !reportedSources.has(path.toLowerCase()))
    : [];

  return (
    <Dialog
      open
      onClose={() => {
        if (!running) onClose();
      }}
      title={t("fw.batch.title", { count: pendingPaths.length })}
      size="lg"
      ariaLabel={t("fw.batch.title", { count: pendingPaths.length })}
      footer={
        <>
          <button type="button" className="btn" disabled={running} onClick={onClose}>
            {t("common.cancel")}
          </button>
          {running && job && !isFileJobTerminal(job) && job.cancelable && !job.cancelRequested && (
            <button
              type="button"
              className="btn"
              disabled={cancelBusy}
              onClick={() => void requestCancel()}
            >
              {t("fw.batch.cancelJob")}
            </button>
          )}
          <button type="button" className="btn primary" disabled={blocked || running || executable.length === 0} onClick={() => void execute()}>
            {running ? t("fw.batch.running") : t("fw.batch.execute", { count: executable.length })}
          </button>
        </>
      }
    >
      <div className="fw-batch-modes" role="group" aria-label={t("fw.batch.modeAria")}>
        {MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={`fw-batch-mode${options.mode === mode ? " is-active" : ""}`}
            onClick={() => update({ mode })}
          >
            {t(`fw.batch.mode.${mode}`)}
          </button>
        ))}
      </div>

      <div className="fw-dialog-field">
        {options.mode === "prefix" && (
          <label>
            <span>{t("fw.batch.prefix")}</span>
            <input value={options.prefix} onChange={(e) => update({ prefix: e.target.value })} />
          </label>
        )}
        {options.mode === "suffix" && (
          <label>
            <span>{t("fw.batch.suffix")}</span>
            <input value={options.suffix} onChange={(e) => update({ suffix: e.target.value })} />
          </label>
        )}
        {(options.mode === "replace" || options.mode === "delete") && (
          <label>
            <span>{t("fw.batch.find")}</span>
            <input value={options.find} onChange={(e) => update({ find: e.target.value })} />
          </label>
        )}
        {options.mode === "replace" && (
          <label>
            <span>{t("fw.batch.replaceWith")}</span>
            <input value={options.replace} onChange={(e) => update({ replace: e.target.value })} />
          </label>
        )}
        {options.mode === "sequence" && (
          <div className="fw-batch-inline">
            <label>
              <span>{t("fw.batch.start")}</span>
              <input
                type="number"
                min={0}
                value={options.start}
                onChange={(e) => update({ start: Number(e.target.value) || 0 })}
              />
            </label>
            <label>
              <span>{t("fw.batch.digits")}</span>
              <input
                type="number"
                min={1}
                max={12}
                value={options.digits}
                onChange={(e) => update({ digits: Number(e.target.value) || 1 })}
              />
            </label>
          </div>
        )}
      </div>

      <Checkbox
        checked={options.preserveExtension}
        onChange={(preserveExtension) => update({ preserveExtension })}
        label={t("fw.batch.preserveExtension")}
        className="fw-batch-check"
      />

      {(invalid.length > 0 || conflicts.length > 0) && (
        <div className="fw-batch-alert" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>
            {t("fw.batch.blocked", {
              invalid: invalid.length,
              conflicts: conflicts.length,
            })}
          </span>
        </div>
      )}

      <div className="fw-batch-summary" role="status">
        <span>{t("fw.batch.summary", { ready: executable.length, unchanged: unchanged.length })}</span>
        {checking && <span>{t("fw.batch.checking")}</span>}
      </div>

      {result && (
        <div className="fw-batch-result" role="alert">
          <div className="fw-batch-result-title">
            {t("fw.batch.resultFailed", { ok: result.ok, failed: result.failed, skipped: result.skipped })}
          </div>
          <ul>
            {resultEntries.map((entry, index) => (
              <li key={`${entry.source}-${index}`} className={`is-${entry.status}`}>
                <span className="fw-batch-old">{basenameOf(entry.source)}</span>
                <span className="fw-batch-new">{entry.target ? basenameOf(entry.target) : "—"}</span>
                <span className="fw-batch-reason">
                  {resultStatusLabel(entry.status)}
                  {entry.reason ? `：${entry.reason}` : ""}
                </span>
              </li>
            ))}
            {unprocessed.map((path) => (
              <li key={`pending-${path}`} className="is-skipped">
                <span className="fw-batch-old">{basenameOf(path)}</span>
                <span className="fw-batch-new">—</span>
                <span className="fw-batch-reason">{t("fw.batch.unprocessed")}</span>
              </li>
            ))}
          </ul>
          {result.entries.length > resultEntries.length && (
            <p className="fw-batch-more">
              {t("fw.batch.previewLimited", { count: result.entries.length - resultEntries.length })}
            </p>
          )}
          <p className="fw-batch-recovery">{t("fw.batch.recovery")}</p>
        </div>
      )}

      <div className="fw-batch-preview" role="table" aria-label={t("fw.batch.previewAria")}>
        <div className="fw-batch-preview-head" role="row">
          <span role="columnheader">{t("fw.batch.columnOld")}</span>
          <span role="columnheader">{t("fw.batch.columnNew")}</span>
          <span role="columnheader">{t("fw.batch.columnStatus")}</span>
        </div>
        {previewLimited.map((item) => (
          <div
            key={item.path}
            className={`fw-batch-preview-row is-${item.status}`}
            role="row"
            title={item.reason ?? item.target}
          >
            <span className="fw-batch-old" role="cell">
              {item.oldName}
            </span>
            <span className="fw-batch-new" role="cell">
              {item.newName}
            </span>
            <span className="fw-batch-status" role="cell">
              {item.status === "ok" ? (
                <Check size={11} aria-hidden="true" />
              ) : item.status === "unchanged" ? null : (
                <X size={11} aria-hidden="true" />
              )}
              {statusLabel(item)}
            </span>
          </div>
        ))}
        {basePreview.length > previewLimited.length && (
          <div className="fw-batch-more">{t("fw.batch.previewLimited", { count: basePreview.length - previewLimited.length })}</div>
        )}
      </div>
    </Dialog>
  );
}
