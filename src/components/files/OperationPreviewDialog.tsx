//! 文件操作预演确认框：只展示后端只读统计，不执行任何文件操作。
//! 用户确认后才回到既有 fsops 任务路径；取消不产生 IPC 写入。

import { AlertTriangle } from "lucide-react";

import { Dialog } from "../ui/Dialog";
import { useLocale } from "../../hooks/useLocale";
import { formatSize } from "../../lib/filesWorkspace/fileMeta";
import { basename } from "../../lib/filesWorkspace/pathUtils";
import type { OperationPreview } from "../../lib/bridge";

export interface OperationPreviewRequest {
  preview: OperationPreview;
  /** 确认后由调用方决定先进入冲突决策还是直接执行。 */
  onConfirm: () => void;
  onCancel: () => void;
}

interface Props {
  request: OperationPreviewRequest | null;
}

export default function OperationPreviewDialog({ request }: Props) {
  const { t } = useLocale();
  const preview = request?.preview;

  return (
    <Dialog
      open={request !== null}
      onClose={() => request?.onCancel()}
      title={t("fw.opPreview.title")}
      size="md"
      ariaLabel={t("fw.opPreview.title")}
      footer={
        <>
          <button type="button" className="btn" onClick={() => request?.onCancel()}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" onClick={() => request?.onConfirm()}>
            {t("fw.opPreview.confirm")}
          </button>
        </>
      }
    >
      {preview && (
        <div className="fw-preview-summary">
          <p>
            {t(preview.effect === "move" ? "fw.opPreview.willMove" : "fw.opPreview.willCopy", {
              items: preview.items,
              files: preview.files,
              dirs: preview.dirs,
              size: formatSize(preview.bytes),
            })}
          </p>
          {!preview.complete && (
            <p className="fw-preview-alert" role="alert">
              <AlertTriangle size={13} aria-hidden="true" /> {t("fw.opPreview.incomplete")}
            </p>
          )}
          {preview.conflicts.length > 0 && (
            <div>
              <p>{t("fw.opPreview.conflicts", { count: preview.conflicts.length })}</p>
              <ul className="fw-conflict-list">
                {preview.conflicts.slice(0, 6).map((conflict) => (
                  <li key={`${conflict.source}|${conflict.target}`}>
                    <span className="fw-conflict-name">{basename(conflict.source)}</span>
                    <span className="fw-conflict-kind">
                      {conflict.kind === "dir"
                        ? t("fw.conflict.kindDir")
                        : conflict.kind === "link"
                          ? t("fw.conflict.kindLink")
                          : t("fw.conflict.kindFile")}
                    </span>
                  </li>
                ))}
              </ul>
              {preview.conflicts.length > 6 && (
                <p className="fw-template-hint">
                  {t("fw.opPreview.more", { count: preview.conflicts.length - 6 })}
                </p>
              )}
            </div>
          )}
          {preview.inaccessible.length > 0 && (
            <p className="fw-preview-alert">
              {t("fw.opPreview.inaccessible", { count: preview.inaccessible.length })}
            </p>
          )}
          {preview.duplicates.length > 0 && (
            <p className="fw-preview-hint">
              {t("fw.opPreview.duplicates", { count: preview.duplicates.length })}
            </p>
          )}
          {preview.warnings.length > 0 && (
            <ul className="fw-preview-warnings">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
