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
import { fsBatchRename, fsStat, type FsOpReport } from "../../lib/bridge";
import { invalidateDirs } from "../../lib/filesWorkspace/dirCache";
import { parentOf } from "../../lib/filesWorkspace/pathUtils";
import { finishQueueOperation, startQueueOperation, withFileOperationSlot } from "../../lib/filesWorkspace/operationQueue";
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

  useEffect(() => {
    if (request) {
      setOptions(DEFAULT_BATCH_RENAME_OPTIONS);
      setExisting(new Set());
      setRunning(false);
      setResult(null);
    }
  }, [request]);

  // 先按“无已存在”生成目标，再只读 fs_stat 目标路径；不改文件，不后台扫目录。
  const basePreview = useMemo(
    () => (request ? buildBatchRenamePreview(request.paths, options, existing) : []),
    [request, options, existing],
  );

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setChecking(true);
    const targets = buildBatchRenamePreview(request.paths, options, []).map((item) => item.target);
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
  }, [request, options]);

  if (!request) return null;

  const invalid = basePreview.filter((item) => item.status === "invalid");
  const conflicts = basePreview.filter((item) => item.status === "conflict");
  const unchanged = basePreview.filter((item) => item.status === "unchanged");
  const executable = basePreview.filter((item) => item.status === "ok");
  const blocked = invalid.length > 0 || conflicts.length > 0 || request.paths.length > 500;
  const previewLimited = basePreview.slice(0, 200);

  const update = (patch: Partial<BatchRenameOptions>) => setOptions((prev) => ({ ...prev, ...patch }));

  const execute = async () => {
    if (blocked || !executable.length || running) return;
    setRunning(true);
    const op = startOperation("file", "workspace_batch_rename", {
      component: "文件工作区",
      metadata: { count: executable.length },
    });
    startQueueOperation({ id: op.id, effect: "rename", total: executable.length });
    try {
      op.stage("ipc");
      const report = await withFileOperationSlot(() =>
        fsBatchRename(
          executable.map((item) => ({ path: item.path, newName: item.newName })),
          op.id,
        ),
      );
      finishQueueOperation(op.id, report);
      setResult(report);
      const dirs = [...new Set(executable.map((item) => parentOf(item.path) ?? "").filter(Boolean))];
      invalidateDirs(dirs);
      showToast(
        t("fw.batch.result", { ok: report.ok, failed: report.failed, skipped: report.skipped }),
        { kind: report.failed > 0 ? "warning" : "success" },
      );
      if (report.failed === 0) onClose();
    } catch (e) {
      finishQueueOperation(op.id, null, errorMessage(e));
      showToast(errorMessage(e), { kind: "error" });
    } finally {
      setRunning(false);
    }
  };

  const statusLabel = (item: BatchRenamePreviewItem) => {
    if (item.status === "invalid") return t("fw.batch.statusInvalid");
    if (item.status === "conflict") return t("fw.batch.statusConflict");
    if (item.status === "unchanged") return t("fw.batch.statusUnchanged");
    return t("fw.batch.statusOk");
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!running) onClose();
      }}
      title={t("fw.batch.title", { count: request.paths.length })}
      size="lg"
      ariaLabel={t("fw.batch.title", { count: request.paths.length })}
      footer={
        <>
          <button type="button" className="btn" disabled={running} onClick={onClose}>
            {t("common.cancel")}
          </button>
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

      {result && result.failed > 0 && (
        <div className="fw-batch-result" role="alert">
          <div className="fw-batch-result-title">
            {t("fw.batch.resultFailed", { ok: result.ok, failed: result.failed, skipped: result.skipped })}
          </div>
          <ul>
            {result.entries
              .filter((entry) => entry.status === "failed")
              .slice(0, 8)
              .map((entry) => (
                <li key={entry.source}>
                  <span className="fw-batch-old">{entry.source.split(/[\\/]/).filter(Boolean).pop()}</span>
                  <span className="fw-batch-reason">{entry.reason ?? t("fw.batch.unknownFailure")}</span>
                </li>
              ))}
          </ul>
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
