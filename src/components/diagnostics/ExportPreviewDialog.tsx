//! 导出前预览确认对话框。
//!
//! 流程硬约束（契约 §3.3）：
//! - 打开对话框先调 `diagnosticsExportPreview`（只读、不落盘），展示时间范围、
//!   条数、错误/警告、涉及模块、大小估算、脱敏状态与两类附加内容；
//! - 安全审计默认**不包含**，必须用户显式勾选；勾选后重新拉取预览；
//! - 只有用户在对话框里点「确认导出」才调 `diagnosticsExport`；
//!   取消 / 关闭 / Escape / 点遮罩都不得产生文件；
//! - 预览失败、空结果、导出中都有独立状态；前端不一次性渲染全量事件，
//!   大文件由后端流式处理，本对话框只展示统计元数据。

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Checkbox, Dialog } from "../ui";
import { errorMessage } from "../../lib/errors";
import { useLocale } from "../../hooks/useLocale";
import {
  diagnosticsExport,
  diagnosticsExportPreview,
  type DiagnosticExportResult,
  type DiagnosticQuery,
  type DiagnosticsExportPreview,
} from "../../lib/bridge";

interface ExportPreviewDialogProps {
  open: boolean;
  /** 本次导出对应的诊断查询（链路视图只带 operationId）。 */
  filter: DiagnosticQuery;
  onCancel: () => void;
  /** 导出成功后回调；父级负责关闭对话框、记录最近导出结果。 */
  onExported: (result: DiagnosticExportResult) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function shortTime(iso?: string | null): string {
  if (!iso) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

export default function ExportPreviewDialog({
  open,
  filter,
  onCancel,
  onExported,
}: ExportPreviewDialogProps) {
  const { t } = useLocale();
  const [includeAudit, setIncludeAudit] = useState(false);
  const [preview, setPreview] = useState<DiagnosticsExportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  /** 预览竞态：快速切换勾选时丢弃过期响应。 */
  const seqRef = useRef(0);

  // 每次打开都回到「不含安全审计」的默认预估。
  useEffect(() => {
    if (!open) return;
    setIncludeAudit(false);
    setExporting(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    diagnosticsExportPreview(filter, includeAudit)
      .then((next) => {
        if (seq !== seqRef.current) return;
        setPreview(next);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (seq !== seqRef.current) return;
        setPreview(null);
        setError(errorMessage(e));
        setLoading(false);
      });
  }, [open, filter, includeAudit]);

  async function onConfirm() {
    if (!preview || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const result = await diagnosticsExport(filter, includeAudit);
      onExported(result);
    } catch (e) {
      // 导出失败保留对话框，展示后端原文，不静默重试。
      setError(errorMessage(e));
      setExporting(false);
    }
  }

  const recordsEmpty = preview ? preview.records === 0 : false;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      size="md"
      ariaLabel={t("diagnosticsCenter.exportPreview.title")}
      title={t("diagnosticsCenter.exportPreview.title")}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={exporting}>
            {t("diagnosticsCenter.exportPreview.cancel")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void onConfirm()}
            disabled={loading || Boolean(error) || recordsEmpty || exporting}
          >
            {exporting ? (
              <Loader2 size={13} className="spin" aria-hidden="true" />
            ) : null}
            <span>
              {exporting
                ? t("diagnosticsCenter.exportPreview.busy")
                : t("diagnosticsCenter.exportPreview.confirm")}
            </span>
          </button>
        </>
      }
    >
      <p className="diag-preview-hint">{t("diagnosticsCenter.exportPreview.hint")}</p>

      {loading ? (
        <div className="diag-center-state">{t("diagnosticsCenter.exportPreview.loading")}</div>
      ) : error ? (
        <div className="diag-center-state is-error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{t("diagnosticsCenter.exportPreview.error", { error })}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              const seq = ++seqRef.current;
              setLoading(true);
              setError(null);
              diagnosticsExportPreview(filter, includeAudit)
                .then((next) => {
                  if (seq !== seqRef.current) return;
                  setPreview(next);
                  setLoading(false);
                })
                .catch((e: unknown) => {
                  if (seq !== seqRef.current) return;
                  setPreview(null);
                  setError(errorMessage(e));
                  setLoading(false);
                });
            }}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : !preview ? null : recordsEmpty ? (
        <div className="diag-center-state diag-center-state-empty">
          <strong>{t("diagnosticsCenter.exportPreview.empty")}</strong>
        </div>
      ) : (
        <dl className="diag-preview-rows">
          <div className="diag-preview-row">
            <dt>{t("diagnosticsCenter.exportPreview.range")}</dt>
            <dd className="diag-center-mono">
              {preview.since && preview.until
                ? `${shortTime(preview.since)} — ${shortTime(preview.until)}`
                : t("diagnosticsCenter.exportPreview.rangeAll")}
            </dd>
          </div>
          <div className="diag-preview-row">
            <dt>{t("diagnosticsCenter.exportPreview.records")}</dt>
            <dd className="diag-center-mono">{preview.records}</dd>
          </div>
          <div className="diag-preview-row">
            <dt>{t("diagnosticsCenter.exportPreview.errors")}</dt>
            <dd className="diag-center-mono is-error">{preview.errors}</dd>
          </div>
          <div className="diag-preview-row">
            <dt>{t("diagnosticsCenter.exportPreview.warnings")}</dt>
            <dd className="diag-center-mono is-warn">{preview.warnings}</dd>
          </div>
          <div className="diag-preview-row">
            <dt>{t("diagnosticsCenter.exportPreview.modules")}</dt>
            <dd className="diag-center-meta-value">
              {preview.modules.length > 0
                ? preview.modules.join(", ")
                : t("diagnosticsCenter.exportPreview.modulesNone")}
            </dd>
          </div>
          <div className="diag-preview-row">
            <dt>{t("diagnosticsCenter.exportPreview.size")}</dt>
            <dd className="diag-center-mono">{formatBytes(preview.estimatedBytes)}</dd>
          </div>
          <div className="diag-preview-row">
            <dt>{t("diagnosticsCenter.exportPreview.redaction")}</dt>
            <dd>
              <span className="diag-center-flag is-ok">
                {t("diagnosticsCenter.exportPreview.redactionApplied")}
              </span>
            </dd>
          </div>
          <div className="diag-preview-row">
            <dt>{t("diagnosticsCenter.exportPreview.includesDevice")}</dt>
            <dd className="diag-center-mono">
              {preview.includesDeviceDiagnostics
                ? t("diagnosticsCenter.exportPreview.yes")
                : t("diagnosticsCenter.exportPreview.no")}
            </dd>
          </div>
          <div className="diag-preview-row diag-preview-row-check">
            <Checkbox
              checked={includeAudit}
              onChange={setIncludeAudit}
              ariaLabel={t("diagnosticsCenter.exportPreview.includesAudit")}
              label={
                <span>
                  <span>{t("diagnosticsCenter.exportPreview.includesAudit")}</span>
                  <span className="diag-preview-check-hint">
                    {t("diagnosticsCenter.exportPreview.includesAuditHint")}
                  </span>
                </span>
              }
            />
          </div>
          {preview.truncated && (
            <div className="diag-center-note is-warn" role="status">
              <AlertTriangle size={13} aria-hidden="true" />
              <span>{t("diagnosticsCenter.exportPreview.truncated")}</span>
            </div>
          )}
        </dl>
      )}
    </Dialog>
  );
}
