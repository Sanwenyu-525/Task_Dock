//! 发送预览与确认：预览参数快照 + 执行一致性。
//!
//! 硬约束：
//! - 预览成功时记录 `ids / target / options / version`；
//! - 选择、目标、文本格式、合并模式、复制/移动、链接方式、冲突策略任一变化 → 快照失效；
//! - 只有当前参数与快照完全一致时「确认发送」才可用；
//! - 执行使用**快照参数**，不是当前表单状态；重新预览会重新校验目标目录。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import Select from "../ui/Select";
import { errorMessage } from "../../lib/errors";
import * as client from "../../lib/crossTab/transferClient";
import {
  createSnapshot,
  snapshotMatches,
  type PreviewSnapshot,
} from "../../lib/crossTab/previewSnapshot";
import type { TransferBatch, TransferOptions, TransferPreview, TransferTarget } from "../../lib/crossTab/types";
import { useTransferStore } from "../../store/useTransferStore";
import { useLocale } from "../../hooks/useLocale";
import type { Notify } from "./ActionDispatcher";

export interface TransferConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  ids: string[];
  target: TransferTarget | null;
  options: TransferOptions;
  onOptionsChange: (next: TransferOptions) => void;
  onNotify: Notify;
  onExecuted?: (batch: TransferBatch) => void;
}

export default function TransferConfirmDialog({
  open,
  onClose,
  ids,
  target,
  options,
  onOptionsChange,
  onNotify,
  onExecuted,
}: TransferConfirmDialogProps) {
  const { t } = useLocale();
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [snapshot, setSnapshot] = useState<PreviewSnapshot | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const version = useRef(0);
  const runSeq = useRef(0);

  const current = useMemo(
    () => ({ ids, target: target ?? { module: "files", ref: "" }, options }),
    [ids, target, options],
  );
  const fresh = snapshotMatches(snapshot, current);

  const runPreview = useCallback(async () => {
    const request = ++runSeq.current;
    if (!target || !target.ref.trim()) {
      setPreview(null);
      setSnapshot(null);
      setPreviewError(t("transfer.targetRequired"));
      return;
    }
    if (ids.length === 0) {
      setPreview(null);
      setSnapshot(null);
      setPreviewError(t("transfer.emptySelectionHint"));
      return;
    }
    setPreviewing(true);
    setPreviewError("");
    try {
      // 每次预览都重新校验目标：目录可能被删除/改名。
      const validation = await client.validateTarget(target);
      if (request !== runSeq.current) return;
      if (!validation.valid) {
        setPreview(null);
        setSnapshot(null);
        setPreviewError(validation.message || t("transfer.targetInvalid"));
        return;
      }
      const result = await client.previewTransfer(ids, target, options);
      if (request !== runSeq.current) return;
      version.current += 1;
      setPreview(result);
      setSnapshot(createSnapshot({ ids, target, options }, version.current));
    } catch (error) {
      if (request !== runSeq.current) return;
      setPreview(null);
      setSnapshot(null);
      setPreviewError(errorMessage(error));
    } finally {
      if (request === runSeq.current) setPreviewing(false);
    }
  }, [ids, options, t, target]);

  useEffect(() => {
    if (!open) {
      runSeq.current += 1;
      setPreview(null);
      setSnapshot(null);
      setPreviewError("");
      setPreviewing(false);
      setExecuting(false);
      return;
    }
    void runPreview();
    // 只在打开时自动预览一次；后续参数变化需要用户显式「更新预览」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function confirm() {
    if (!snapshot || !fresh) {
      onNotify(t("transfer.previewStale"), "warning");
      return;
    }
    // 执行前再校验一次目标（目录可能在预览后被删除）。
    const targetToUse: TransferTarget = { module: snapshot.targetModule, ref: snapshot.targetRef };
    const validation = await client.validateTarget(targetToUse);
    if (!validation.valid) {
      setPreview(null);
      setSnapshot(null);
      setPreviewError(validation.message || t("transfer.targetInvalid"));
      onNotify(validation.message || t("transfer.targetInvalid"), "error");
      return;
    }
    setExecuting(true);
    try {
      // 用快照参数执行，杜绝「预览 A、执行 B」。
      const batch = await useTransferStore
        .getState()
        .send(snapshot.itemIds, targetToUse, snapshot.options);
      onNotify(t("transfer.started", { count: batch.total }), "success");
      onExecuted?.(batch);
      onClose();
    } catch (error) {
      onNotify(errorMessage(error), "error");
    } finally {
      setExecuting(false);
    }
  }

  const blocked = !preview?.targetValid || !fresh || previewing || executing;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("transfer.previewTitle")}
      size="md"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn" disabled={previewing || !preview} onClick={() => void runPreview()}>
            {previewing ? <Loader2 size={12} className="tp-spin" /> : null} {t("transfer.repreview")}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={blocked}
            data-tip={!fresh ? t("transfer.previewStale") : undefined}
            onClick={() => void confirm()}
          >
            {executing ? <Loader2 size={12} className="tp-spin" /> : null} {t("transfer.confirmSend")}
          </button>
        </>
      }
    >
      {previewError ? (
        <p className="tp-error">{previewError}</p>
      ) : preview ? (
        <div className="tp-preview">
          <p className="tp-preview-target">
            {t("transfer.previewTarget")} <code>{preview.targetRef}</code>
          </p>
          <div className="tp-preview-options">
            <label>
              <span>{t("transfer.optionTextFormat")}</span>
              <Select
                value={options.textFormat}
                options={[
                  { value: "txt", label: t("transfer.optionTxt") },
                  { value: "md", label: t("transfer.optionMarkdown") },
                ]}
                onChange={(value) => onOptionsChange({ ...options, textFormat: value as TransferOptions["textFormat"] })}
                ariaLabel={t("transfer.optionTextFormat")}
                block
                size="sm"
              />
            </label>
            <label>
              <span>{t("transfer.optionTextMode")}</span>
              <Select
                value={options.textMode}
                options={[
                  { value: "separate", label: t("transfer.optionSeparate") },
                  { value: "merge", label: t("transfer.optionMerge") },
                ]}
                onChange={(value) => onOptionsChange({ ...options, textMode: value as TransferOptions["textMode"] })}
                ariaLabel={t("transfer.optionTextMode")}
                block
                size="sm"
              />
            </label>
            <label>
              <span>{t("transfer.optionFileOperation")}</span>
              <Select
                value={options.fileOperation}
                options={[
                  { value: "copy", label: t("transfer.optionCopy") },
                  { value: "move", label: t("transfer.optionMove") },
                ]}
                onChange={(value) => onOptionsChange({ ...options, fileOperation: value as TransferOptions["fileOperation"] })}
                ariaLabel={t("transfer.optionFileOperation")}
                block
                size="sm"
              />
            </label>
            <label>
              <span>{t("transfer.optionUrlMode")}</span>
              <Select
                value={options.urlMode}
                options={[
                  { value: "url", label: t("transfer.optionUrlFile") },
                  { value: "markdown", label: t("transfer.optionUrlMarkdown") },
                ]}
                onChange={(value) => onOptionsChange({ ...options, urlMode: value as TransferOptions["urlMode"] })}
                ariaLabel={t("transfer.optionUrlMode")}
                block
                size="sm"
              />
            </label>
            <label>
              <span>{t("transfer.optionConflict")}</span>
              <Select
                value={options.conflict}
                options={[
                  { value: "rename", label: t("transfer.optionRename") },
                  { value: "skip", label: t("transfer.optionSkip") },
                  { value: "overwrite", label: t("transfer.optionOverwrite") },
                ]}
                onChange={(value) => onOptionsChange({ ...options, conflict: value as TransferOptions["conflict"] })}
                ariaLabel={t("transfer.optionConflict")}
                block
                size="sm"
              />
            </label>
          </div>
          <p className={`tp-preview-hint${fresh ? "" : " is-stale"}`} aria-live="polite">
            {fresh ? t("transfer.repreviewHint") : t("transfer.previewStale")}
          </p>
          <div className="tp-preview-grid">
            <span>{t("transfer.previewText")}<b>{preview.counts.text + preview.counts.richtext}</b></span>
            <span>{t("transfer.previewImage")}<b>{preview.counts.image}</b></span>
            <span>{t("transfer.previewFile")}<b>{preview.counts.file + preview.counts.directory}</b></span>
            <span>{t("transfer.previewUrl")}<b>{preview.counts.url}</b></span>
            <span>{t("transfer.previewFiles")}<b>{preview.plannedFiles}</b></span>
            <span>{t("transfer.previewUnsupported")}<b>{preview.counts.unsupported}</b></span>
          </div>
          {preview.conflicts.length > 0 && (
            <div className="tp-preview-conflicts">
              <p className="tp-preview-warn">
                {t("transfer.previewConflicts", { count: preview.conflicts.length })}
              </p>
              <ul className="tp-preview-list">
                {preview.conflicts.slice(0, 6).map((entry) => (
                  <li key={entry.name}>
                    {entry.name}：{entry.resolution}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.unsupported.length > 0 && (
            <>
              <p className="tp-preview-warn">{t("transfer.rejectedHint")}</p>
              <ul className="tp-preview-list">
                {preview.unsupported.map((entry, index) => (
                  <li key={`${entry.itemId}-${index}`}>
                    {entry.title}：{entry.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          {preview.warnings.map((warning) => (
            <p key={warning} className="tp-preview-warn">{warning}</p>
          ))}
        </div>
      ) : (
        <div className="tp-empty">
          {previewing ? <Loader2 size={15} className="tp-spin" /> : null}
          <p>{previewing ? t("common.loading") : t("transfer.previewHint")}</p>
        </div>
      )}
    </Dialog>
  );
}
