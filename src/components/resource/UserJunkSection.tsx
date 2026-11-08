//! 用户级磁盘垃圾清理：回收站、用户/系统临时文件、崩溃转储。
//!
//! 产品边界：
//! - 必须先扫描、再勾选、再确认；默认不勾选任何类别；
//! - 扫描只读；执行只接受服务端 `previewId`（5 分钟、一次性消费）；
//! - 后端对每个候选重新校验根目录归属、文件身份、大小、修改时间与年龄；
//!   占用中或已变化的文件跳过，不会因为「预览过」就删除；
//! - 回收站由 Windows Shell 清空，实际释放量按清空前后统计差测量；
//! - 不自动扫描、不轮询；预览 TTL 到期只用一个一次性计时器，卸载即清理。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  FileWarning,
  HardDrive,
  Recycle,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  resourceJunkExecute,
  resourceJunkPreview,
  type ResourceJunkCategory,
  type ResourceJunkCategoryPreview,
  type ResourceJunkExecutionReport,
  type ResourceJunkPreview,
} from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { normalizeError } from "../../lib/errors";
import { localizedErrorMessage } from "../../i18n/errors";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import { Checkbox } from "../ui";

const CATEGORIES: readonly ResourceJunkCategory[] = [
  "recycle_bin",
  "user_temp",
  "system_temp",
  "crash_dumps",
];

const CATEGORY_INFO: Record<
  ResourceJunkCategory,
  { title: MessageKey; description: MessageKey; icon: typeof HardDrive }
> = {
  recycle_bin: {
    title: "resource.junk.category.recycleBin",
    description: "resource.junk.category.recycleBinDesc",
    icon: Recycle,
  },
  user_temp: {
    title: "resource.junk.category.userTemp",
    description: "resource.junk.category.userTempDesc",
    icon: HardDrive,
  },
  system_temp: {
    title: "resource.junk.category.systemTemp",
    description: "resource.junk.category.systemTempDesc",
    icon: FileWarning,
  },
  crash_dumps: {
    title: "resource.junk.category.crashDumps",
    description: "resource.junk.category.crashDumpsDesc",
    icon: FileWarning,
  },
};

function statusKey(status: ResourceJunkCategoryPreview["status"]): MessageKey {
  switch (status) {
    case "ready":
      return "resource.junk.status.ready";
    case "partial":
      return "resource.junk.status.partial";
    default:
      return "resource.junk.status.unavailable";
  }
}

function errorKey(code: string | null | undefined): MessageKey {
  switch (code) {
    case "SCAN_LIMIT_REACHED":
      return "settings.resourceCleanup.error.scanLimitReached";
    case "SCAN_UNAVAILABLE":
      return "settings.resourceCleanup.error.scanUnavailable";
    case "PARTIAL_READ":
      return "resource.junk.error.partialRead";
    case "PREVIEW_EXPIRED":
      return "settings.resourceCleanup.error.previewExpired";
    case "CLEANUP_BUSY":
      return "settings.resourceCleanup.error.cleanupBusy";
    case "FILE_IN_USE":
      return "settings.resourceCleanup.error.fileInUse";
    case "PERMISSION_DENIED":
      return "settings.resourceCleanup.error.permissionDenied";
    case "PARTIAL_FAILURE":
      return "settings.resourceCleanup.error.partialFailure";
    case "PATH_UNSAFE":
      return "settings.resourceCleanup.error.pathUnsafe";
    case "SHELL_FAILED":
      return "resource.junk.error.shellFailed";
    case "MEASURE_UNAVAILABLE":
      return "resource.junk.error.measureUnavailable";
    case "UNSUPPORTED":
      return "resource.junk.error.unsupported";
    default:
      return "settings.resourceCleanup.error.generic";
  }
}

function junkErrorMessage(reason: unknown, translate: (key: MessageKey) => string): string {
  const error = normalizeError(reason);
  const code = error.reason?.trim() ?? error.message.trim();
  if (/^[A-Z][A-Z0-9_]*$/.test(code)) return translate(errorKey(code));
  return localizedErrorMessage(reason);
}

function isUsable(row: ResourceJunkCategoryPreview): boolean {
  return (row.status === "ready" || row.status === "partial") && row.candidates > 0;
}

function isExpired(preview: ResourceJunkPreview | null): boolean {
  if (!preview) return true;
  const expiresAt = Date.parse(preview.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

export interface UserJunkSectionProps {
  /** 清理完成/失败后请求页面刷新快照（磁盘可用空间已变化）。 */
  onSnapshotInvalidated?: () => void;
}

export default function UserJunkSection({ onSnapshotInvalidated }: UserJunkSectionProps = {}) {
  const { t } = useLocale();
  const [preview, setPreview] = useState<ResourceJunkPreview | null>(null);
  const [report, setReport] = useState<ResourceJunkExecutionReport | null>(null);
  const [selection, setSelection] = useState<ResourceJunkCategory[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [expiryReached, setExpiryReached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const rows = preview?.categories ?? [];
  const selectedRows = useMemo(
    () => rows.filter((row) => selection.includes(row.category) && isUsable(row)),
    [rows, selection],
  );
  const selectedBytes = selectedRows.reduce((sum, row) => sum + row.estimatedBytes, 0);
  const usableSelection = selectedRows.map((row) => row.category);
  const expired = preview ? expiryReached || isExpired(preview) : false;
  const busy = scanning || cleaning;

  // 单个一次性计时器：预览 TTL 到期即失效，必须重新扫描；卸载时清理。
  useEffect(() => {
    if (!preview) return;
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => {
      if (mountedRef.current) setExpiryReached(true);
    }, Math.min(2_147_483_647, remaining));
    return () => window.clearTimeout(timer);
  }, [preview]);

  async function scan() {
    if (busy) return;
    const request = ++requestRef.current;
    setScanning(true);
    setPreview(null);
    setExpiryReached(false);
    setConfirming(false);
    setReport(null);
    setError(null);
    try {
      const result = await resourceJunkPreview([...CATEGORIES]);
      if (!mountedRef.current || request !== requestRef.current) return;
      setPreview(result);
      setSelection((current) =>
        current.filter((category) =>
          result.categories.some((row) => row.category === category && isUsable(row)),
        ),
      );
      if (!result.categories.some((row) => row.status !== "unavailable")) {
        setError(t("resource.junk.error.allUnavailable"));
      }
    } catch (reason) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setError(junkErrorMessage(reason, t));
    } finally {
      if (mountedRef.current && request === requestRef.current) setScanning(false);
    }
  }

  function toggleCategory(category: ResourceJunkCategory, checked: boolean) {
    setSelection((current) => {
      if (checked) return current.includes(category) ? current : [...current, category];
      return current.filter((item) => item !== category);
    });
    setConfirming(false);
  }

  async function execute() {
    if (!preview || expired || busy || usableSelection.length === 0) return;
    const request = ++requestRef.current;
    setCleaning(true);
    setConfirming(false);
    setError(null);
    try {
      const result = await resourceJunkExecute({
        previewId: preview.previewId,
        categories: usableSelection,
      });
      if (!mountedRef.current || request !== requestRef.current) return;
      setReport(result);
      setPreview(null);
      // 预览已被服务端消费：旧的数字立即失效，不允许再次执行。
      setExpiryReached(true);
      onSnapshotInvalidated?.();
    } catch (reason) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setError(junkErrorMessage(reason, t));
      setPreview(null);
      setExpiryReached(true);
      onSnapshotInvalidated?.();
    } finally {
      if (mountedRef.current && request === requestRef.current) setCleaning(false);
    }
  }

  const categoryName = (category: ResourceJunkCategory) => t(CATEGORY_INFO[category].title);

  return (
    <section className="resource-cleanup" aria-labelledby="resource-junk-title">
      <div className="resource-cleanup-section-head">
        <h3 className="resource-cleanup-heading" id="resource-junk-title">
          {t("resource.junk.title")}
        </h3>
        {preview && (
          <span className="resource-volume-count">
            {t("resource.junk.minAge", { days: Math.round(preview.minimumAgeHours / 24) })}
          </span>
        )}
      </div>
      <p className="setting-note">{t("resource.junk.desc")}</p>

      {preview ? (
        <div className="resource-cleanup-categories">
          {CATEGORIES.map((category) => {
            const row = rows.find((candidate) => candidate.category === category);
            const info = CATEGORY_INFO[category];
            const Icon = info.icon;
            const selectable = Boolean(row && isUsable(row)) && !busy && !expired;
            const categoryError = row?.errorCode ? t(errorKey(row.errorCode)) : null;
            return (
              <div className="resource-cleanup-row" key={category}>
                <Checkbox
                  className="resource-cleanup-checkbox"
                  ariaLabel={categoryName(category)}
                  checked={selection.includes(category)}
                  disabled={!selectable}
                  onChange={(checked) => toggleCategory(category, checked)}
                  label={
                    <span className="resource-cleanup-label">
                      <span className="resource-cleanup-title">
                        <Icon size={13} aria-hidden="true" />
                        {categoryName(category)}
                      </span>
                      <span className="resource-cleanup-description">
                        {t(info.description)}
                      </span>
                    </span>
                  }
                />
                <div className="resource-cleanup-category-stats">
                  <strong>
                    {row
                      ? t(
                          category === "recycle_bin"
                            ? "resource.junk.items"
                            : "resource.junk.files",
                          { count: row.candidates },
                        )
                      : t("settings.resourceCleanup.unavailable")}
                  </strong>
                  <span>
                    {row
                      ? t("settings.resourceCleanup.estimated", {
                          bytes: formatBytes(row.estimatedBytes),
                        })
                      : t("settings.resourceCleanup.unavailable")}
                  </span>
                  {row && (
                    <span className="resource-cleanup-row-status">
                      {t(statusKey(row.status))}
                      {row.protectedFiles > 0 &&
                        ` · ${t("resource.junk.protected", { count: row.protectedFiles })}`}
                      {row.skippedFiles > 0 &&
                        ` · ${t("settings.resourceCleanup.skipped", { count: row.skippedFiles })}`}
                    </span>
                  )}
                  {categoryError && (
                    <span className="resource-cleanup-error" role="status">
                      {categoryError}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          className="setting-note"
          role={error ? "alert" : "status"}
        >
          {error ?? (scanning ? t("resource.junk.scanning") : t("resource.junk.notScanned"))}
        </div>
      )}

      {preview &&
        rows.every((row) => row.status === "ready" && row.candidates === 0) && (
          <div className="setting-note" role="status">
            {t("resource.junk.noCandidates")}
          </div>
        )}

      <div className="resource-cleanup-actions">
        <button
          className="btn sm"
          type="button"
          onClick={() => void scan()}
          disabled={busy}
        >
          <RefreshCw
            size={12}
            className={scanning ? "spin" : undefined}
            aria-hidden="true"
          />{" "}
          {t(
            scanning
              ? "resource.junk.scanning"
              : preview
                ? "resource.junk.rescan"
                : "resource.junk.scan",
          )}
        </button>
        <button
          className="btn sm"
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy || !preview || expired || usableSelection.length === 0 || confirming}
        >
          <Trash2 size={12} aria-hidden="true" /> {t("resource.junk.clean")}
        </button>
        <span className="resource-cleanup-selection-summary" aria-live="polite">
          {preview
            ? usableSelection.length > 0
              ? `${t("resource.junk.selected", { count: usableSelection.length })} · ${t("settings.resourceCleanup.totalEstimate", { bytes: formatBytes(selectedBytes) })}`
              : t("resource.junk.noSelection")
            : null}
        </span>
      </div>

      {preview && expired && (
        <div className="setting-note resource-cleanup-error" role="alert">
          {t("resource.junk.expired")}
        </div>
      )}
      {preview && !expired && usableSelection.length === 0 && (
        <div className="setting-note">{t("resource.junk.noSelection")}</div>
      )}

      {confirming && preview && !expired && (
        <div
          className="panel-block resource-cleanup-confirm"
          role="group"
          aria-labelledby="resource-junk-confirm-title"
        >
          <div className="resource-cleanup-confirm-title" id="resource-junk-confirm-title">
            <AlertTriangle size={14} aria-hidden="true" />
            {t("resource.junk.confirmTitle", { bytes: formatBytes(selectedBytes) })}
          </div>
          <div className="resource-cleanup-confirm-list">
            {usableSelection.map((category, index) => (
              <span key={category}>
                {index > 0 && t("settings.resourceCleanup.categorySeparator")}
                {categoryName(category)}
              </span>
            ))}
          </div>
          <p className="setting-note">{t("resource.junk.confirmWarning")}</p>
          <div className="resource-cleanup-actions">
            <button
              className="btn sm"
              type="button"
              onClick={() => setConfirming(false)}
              disabled={cleaning}
            >
              {t("settings.resourceCleanup.cancel")}
            </button>
            <button
              className="btn sm"
              type="button"
              onClick={() => void execute()}
              disabled={cleaning || usableSelection.length === 0}
            >
              {t(cleaning ? "resource.junk.cleaning" : "resource.junk.confirm")}
            </button>
          </div>
        </div>
      )}

      {cleaning && (
        <div className="setting-note" role="status">
          {t("resource.junk.cleaning")}
        </div>
      )}

      {report && (
        <section
          className="panel-block resource-cleanup-result"
          aria-live="polite"
          aria-labelledby="resource-junk-result-title"
        >
          <h3 id="resource-junk-result-title">{t("resource.junk.resultTitle")}</h3>
          <p>
            {report.status === "success"
              ? t("resource.junk.resultSuccess", {
                  bytes: formatBytes(report.totalFreedBytes),
                  files: report.totalDeletedFiles,
                })
              : report.status === "partial"
                ? t("resource.junk.resultPartial", {
                    bytes: formatBytes(report.totalFreedBytes),
                    files: report.totalDeletedFiles,
                  })
                : t("resource.junk.resultFailed")}
          </p>
          <ul>
            {report.categories.map((result) => (
              <li key={result.category}>
                <strong>{categoryName(result.category)}</strong>
                {` · ${t("settings.resourceCleanup.status." + result.status as MessageKey)}`}
                {` · ${t("resource.junk.freed", { bytes: formatBytes(result.freedBytes) })}`}
                {` · ${t("settings.resourceCleanup.deleted", { count: result.deletedFiles })}`}
                {` · ${t("settings.resourceCleanup.skipped", { count: result.skippedFiles })}`}
                {` · ${t("settings.resourceCleanup.failed", { count: result.failedFiles })}`}
                {result.errorCode && (
                  <span className="resource-cleanup-error">
                    {" · "}
                    {t(errorKey(result.errorCode))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="setting-note resource-management-safety">{t("resource.junk.safety")}</p>
    </section>
  );
}
