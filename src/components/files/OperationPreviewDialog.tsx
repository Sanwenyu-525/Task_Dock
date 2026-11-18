//! 文件操作预演确认框：只展示后端只读统计，不执行任何文件操作。
//! 用户确认后才回到既有 fsops 任务路径；取消不产生 IPC 写入。
//!
//! 完整性门禁（FW-OPS-003，r9）：`complete=false` 时统计不完整——普通「确认」按钮
//! 直接隐藏，必须勾选「我理解本次只会处理能够成功访问的文件」后才允许继续；
//! 勾选状态在每次打开新预演时重置，不得沿用上一次的确认。

import { useEffect, useState } from "react";
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
  const incomplete = preview ? !preview.complete : false;
  const [ackIncomplete, setAckIncomplete] = useState(false);

  // 每次打开新预演（preview 引用变化）都重置勾选：预演结果不同，风险提示必须重新确认。
  useEffect(() => {
    setAckIncomplete(false);
  }, [preview]);

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
          {incomplete ? (
            // 不完整统计：默认不能执行；独立勾选确认后才允许处理可访问项。
            <button
              type="button"
              className="btn"
              disabled={!ackIncomplete}
              onClick={() => request?.onConfirm()}
            >
              {t("fw.opPreview.gateContinue")}
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={() => request?.onConfirm()}>
              {t("fw.opPreview.confirm")}
            </button>
          )}
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
          {incomplete && (
            <div className="fw-preview-gate" role="alertgroup">
              <p className="fw-preview-alert" role="alert">
                <AlertTriangle size={13} aria-hidden="true" /> {t("fw.opPreview.incomplete")}
              </p>
              <p className="fw-template-hint">{t("fw.opPreview.gateBody")}</p>
              <label className="fw-preview-gate-ack">
                <input
                  type="checkbox"
                  checked={ackIncomplete}
                  onChange={(event) => setAckIncomplete(event.target.checked)}
                  aria-label={t("fw.opPreview.gateAck")}
                />
                <span>{t("fw.opPreview.gateAck")}</span>
              </label>
            </div>
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
