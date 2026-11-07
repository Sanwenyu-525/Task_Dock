import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, HardDrive, Image, RefreshCw, Trash2, Volume2 } from "lucide-react";
import {
  resourceCleanupExecute,
  resourceCleanupPreview,
  type ResourceCleanupCategory,
  type ResourceCleanupCategoryPreview,
  type ResourceCleanupExecutionReport,
  type ResourceCleanupPreview,
} from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { normalizeError } from "../../lib/errors";
import { localizedErrorMessage } from "../../i18n/errors";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import { SETTINGS_TTS_CACHE_REFRESH_EVENT } from "../../lib/settingsSections";
import { Checkbox, StatusBadge } from "../ui";

const CATEGORIES: readonly ResourceCleanupCategory[] = [
  "temporary",
  "tts",
  "orphan_thumbnails",
];

const CATEGORY_INFO: Record<
  ResourceCleanupCategory,
  { title: MessageKey; description: MessageKey; icon: typeof HardDrive }
> = {
  temporary: {
    title: "settings.resourceCleanup.category.temporary",
    description: "settings.resourceCleanup.category.temporaryDesc",
    icon: HardDrive,
  },
  tts: {
    title: "settings.resourceCleanup.category.tts",
    description: "settings.resourceCleanup.category.ttsDesc",
    icon: Volume2,
  },
  orphan_thumbnails: {
    title: "settings.resourceCleanup.category.orphanThumbnails",
    description: "settings.resourceCleanup.category.orphanThumbnailsDesc",
    icon: Image,
  },
};

type CleanupPhase = "idle" | "scanning" | "ready" | "partial" | "cleaning" | "success" | "error";

/**
 * 概览可清理量的口径状态。四种数字必须分开：
 * 缓存总量（快照）、扫描估算量（本分区）、选中预计释放量、清理实际释放量。
 * - `ready` / `partial`：当前有效的扫描估算；`partial` 表示部分来源未纳入；
 * - `scanning`：正在扫描，尚无有效估算；
 * - `stale`：之前的估算已过期或被清理动作作废，必须重新扫描；
 * - `failed`：扫描失败或没有任何可用类别，不能显示为 0 B；
 * - `unscanned`：本次会话尚未扫描。
 */
export type CleanupEstimateState =
  | "unscanned"
  | "scanning"
  | "ready"
  | "partial"
  | "stale"
  | "failed";

export interface CleanupEstimate {
  totalBytes: number | null;
  state: CleanupEstimateState;
}

const INITIAL_ESTIMATE: CleanupEstimate = { totalBytes: null, state: "unscanned" };
const STALE_ESTIMATE: CleanupEstimate = { totalBytes: null, state: "stale" };

function previewStatusKey(status: ResourceCleanupCategoryPreview["status"]): MessageKey {
  switch (status) {
    case "ready":
      return "settings.resourceCleanup.status.ready";
    case "partial":
      return "settings.resourceCleanup.status.partial";
    case "incomplete":
      return "settings.resourceCleanup.status.incomplete";
    default:
      return "settings.resourceCleanup.status.unavailable";
  }
}

function errorKey(code: string | null | undefined): MessageKey {
  switch (code) {
    case "SCAN_UNAVAILABLE":
      return "settings.resourceCleanup.error.scanUnavailable";
    case "SCAN_LIMIT_REACHED":
      return "settings.resourceCleanup.error.scanLimitReached";
    case "DATABASE_READ_FAILED":
      return "settings.resourceCleanup.error.databaseReadFailed";
    case "PATH_UNSAFE":
      return "settings.resourceCleanup.error.pathUnsafe";
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
    case "CLEANUP_CANCELLED":
      return "settings.resourceCleanup.error.cancelled";
    case "INTERNAL_ERROR":
      return "settings.resourceCleanup.error.internal";
    case "TEMP_SOURCES_PROTECTED":
      return "settings.resourceCleanup.error.temporarySourcesProtected";
    case "CACHE_LOCK_POISONED":
      return "settings.resourceCleanup.error.cacheLockPoisoned";
    default:
      return "settings.resourceCleanup.error.generic";
  }
}

function cleanupErrorMessage(reason: unknown, translate: (key: MessageKey) => string): string {
  const error = normalizeError(reason);
  const code = error.reason?.trim() ?? error.message.trim();
  if (/^[A-Z][A-Z0-9_]*$/.test(code)) return translate(errorKey(code));
  return localizedErrorMessage(reason);
}

function isPreviewUsable(row: ResourceCleanupCategoryPreview): boolean {
  return row.status === "ready" || row.status === "partial";
}

function isPreviewExpired(preview: ResourceCleanupPreview | null): boolean {
  if (!preview) return true;
  const expiresAt = Date.parse(preview.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

export interface ResourceCleanupSectionProps {
  /**
   * 可清理估算变化：带状态一起上报，页面据此区分
   * 「尚未扫描 / 正在扫描 / 有效估算 / 已过期 / 扫描失败」，
   * 不会在 TTL 到期后继续把旧字节数当成当前可清理量。
   */
  onPreviewChange?: (estimate: CleanupEstimate) => void;
  /** 清理完成/失败后请求页面刷新快照（缓存与磁盘数据已变化）。 */
  onSnapshotInvalidated?: () => void;
}

export default function ResourceCleanupSection({
  onPreviewChange,
  onSnapshotInvalidated,
}: ResourceCleanupSectionProps = {}) {
  const { t } = useLocale();
  const [preview, setPreview] = useState<ResourceCleanupPreview | null>(null);
  const [report, setReport] = useState<ResourceCleanupExecutionReport | null>(null);
  const [phase, setPhase] = useState<CleanupPhase>("idle");
  const [selection, setSelection] = useState<ResourceCleanupCategory[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 预览 TTL 已到：只由一次性的到期计时器设置，不用轮询检查时间。 */
  const [expiryReached, setExpiryReached] = useState(false);
  /** 上报给概览的估算（唯一来源）。 */
  const [estimate, setEstimate] = useState<CleanupEstimate>(INITIAL_ESTIMATE);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  // 概览的「可清理量」来自这里的估算状态：状态变化才上报，不重复请求。
  useEffect(() => {
    onPreviewChange?.(estimate);
  }, [estimate, onPreviewChange]);

  const categoryRows = preview?.categories ?? [];
  const selectedRows = useMemo(
    () => categoryRows.filter((row) => selection.includes(row.category) && isPreviewUsable(row)),
    [categoryRows, selection],
  );
  const selectedBytes = selectedRows.reduce((sum, row) => sum + row.estimatedBytes, 0);
  const usableSelection = selectedRows.map((row) => row.category);
  const expired = preview ? expiryReached || isPreviewExpired(preview) : false;
  const busy = phase === "scanning" || phase === "cleaning";

  // 单个一次性计时器：到点把估算标记为失效并通知页面。没有轮询，卸载即清理。
  useEffect(() => {
    if (!preview) return;
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => {
      if (!mountedRef.current) return;
      setExpiryReached(true);
      setEstimate(STALE_ESTIMATE);
    }, Math.min(2_147_483_647, remaining));
    return () => window.clearTimeout(timer);
  }, [preview]);

  async function scan() {
    if (busy) return;
    const request = ++requestRef.current;
    setPhase("scanning");
    setPreview(null);
    setExpiryReached(false);
    setEstimate({ totalBytes: null, state: "scanning" });
    setReport(null);
    setError(null);
    setConfirming(false);
    try {
      const result = await resourceCleanupPreview([...CATEGORIES]);
      if (!mountedRef.current || request !== requestRef.current) return;
      setPreview(result);
      setSelection((current) =>
        current.filter((category) =>
          result.categories.some(
            (row) => row.category === category && isPreviewUsable(row) && row.candidates > 0,
          ),
        ),
      );
      const hasUsableCategory = result.categories.some(isPreviewUsable);
      const hasPartialCategory = result.categories.some(
        (row) => row.status === "partial" || row.status === "incomplete" || row.status === "unavailable",
      );
      setPhase(hasPartialCategory ? "partial" : hasUsableCategory ? "ready" : "error");
      // 概览只接收「当前有效」的估算：不可用或后端已判过期的预览都不能报数字。
      if (!hasUsableCategory) {
        setEstimate({ totalBytes: null, state: "failed" });
      } else if (isPreviewExpired(result)) {
        setExpiryReached(true);
        setEstimate(STALE_ESTIMATE);
      } else {
        setEstimate({
          totalBytes: result.totalEstimatedBytes,
          state: hasPartialCategory ? "partial" : "ready",
        });
      }
    } catch (reason) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setError(cleanupErrorMessage(reason, t));
      setPhase("error");
      setEstimate({ totalBytes: null, state: "failed" });
    }
  }

  function toggleCategory(category: ResourceCleanupCategory, checked: boolean) {
    setSelection((current) => {
      if (checked) return current.includes(category) ? current : [...current, category];
      return current.filter((item) => item !== category);
    });
    setConfirming(false);
  }

  async function execute() {
    if (!preview || expired || busy || usableSelection.length === 0) return;
    const request = ++requestRef.current;
    setPhase("cleaning");
    setConfirming(false);
    setError(null);
    try {
      const result = await resourceCleanupExecute({
        previewId: preview.previewId,
        categories: usableSelection,
      });
      if (usableSelection.includes("tts")) {
        window.dispatchEvent(new Event(SETTINGS_TTS_CACHE_REFRESH_EVENT));
      }
      if (!mountedRef.current || request !== requestRef.current) return;
      setReport(result);
      setPreview(null);
      // 预览已被服务端消费（即使部分失败也可能已删除文件）：旧估算立即失效。
      setExpiryReached(true);
      setEstimate(STALE_ESTIMATE);
      setPhase(result.status === "success" ? "success" : result.status === "partial" ? "partial" : "error");
      onSnapshotInvalidated?.();
    } catch (reason) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setError(cleanupErrorMessage(reason, t));
      setPreview(null);
      setExpiryReached(true);
      setEstimate(STALE_ESTIMATE);
      setPhase("error");
      onSnapshotInvalidated?.();
    }
  }

  const categoryName = (category: ResourceCleanupCategory) => t(CATEGORY_INFO[category].title);

  return (
    <div className="resource-management">
      <section className="resource-cleanup" aria-labelledby="resource-cleanup-title">
        <div className="resource-cleanup-section-head">
          <h3 className="resource-cleanup-heading" id="resource-cleanup-title">
            {t("settings.resourceCleanup.categoriesTitle")}
          </h3>
          {preview && (
            <StatusBadge
              tone={phase === "partial" ? "warning" : phase === "error" ? "danger" : "neutral"}
              size="sm"
            >
              {t(`settings.resourceCleanup.phase.${phase}` as MessageKey)}
            </StatusBadge>
          )}
        </div>

      {preview ? (
        <div className="resource-cleanup-categories">
          {CATEGORIES.map((category) => {
            const row = categoryRows.find((candidate) => candidate.category === category);
            const info = CATEGORY_INFO[category];
            const Icon = info.icon;
            const canSelect = Boolean(row && isPreviewUsable(row) && row.candidates > 0) && !busy && !expired;
            const categoryError = row?.errorCode ? t(errorKey(row.errorCode)) : null;
            return (
              <div className="resource-cleanup-row" key={category}>
                <Checkbox
                  className="resource-cleanup-checkbox"
                  ariaLabel={categoryName(category)}
                  checked={selection.includes(category)}
                  disabled={!canSelect}
                  onChange={(checked) => toggleCategory(category, checked)}
                  label={
                    <span className="resource-cleanup-label">
                      <span className="resource-cleanup-title">
                        <Icon size={13} aria-hidden="true" />
                        {categoryName(category)}
                      </span>
                      <span className="resource-cleanup-description">{t(info.description)}</span>
                    </span>
                  }
                />
                <div className="resource-cleanup-category-stats">
                  <strong>
                    {row
                      ? t("settings.resourceCleanup.files", { count: row.candidates })
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
                      {t(previewStatusKey(row.status))}
                      {row.protectedFiles > 0 &&
                        ` · ${t("settings.resourceCleanup.protected", { count: row.protectedFiles })}`}
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
        <div className="setting-note" role={phase === "error" ? "alert" : "status"}>
          {error
            ? error
            : t("settings.resourceCleanup.notScanned")}
        </div>
      )}

      {categoryRows.length === CATEGORIES.length &&
        categoryRows.every((row) => row.status === "ready" && row.candidates === 0) && (
          <div className="setting-note" role="status">
            {t("settings.resourceCleanup.noCandidates")}
          </div>
        )}

      <div className="resource-cleanup-actions">
        <button className="btn sm" type="button" onClick={() => void scan()} disabled={busy}>
          {phase === "scanning" ? (
            <RefreshCw size={12} className="spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={12} aria-hidden="true" />
          )}{" "}
          {t(phase === "scanning" ? "settings.resourceCleanup.scanning" : preview ? "settings.resourceCleanup.rescan" : "settings.resourceCleanup.scan")}
        </button>
        <button
          className="btn sm"
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy || !preview || expired || usableSelection.length === 0 || confirming}
        >
          <Trash2 size={12} aria-hidden="true" /> {t("settings.resourceCleanup.clean")}
        </button>
        {/* 主操作成组靠左；选择摘要吃掉剩余空间并右对齐，避免两个按钮被拉到大两端。 */}
        <span className="resource-cleanup-selection-summary" aria-live="polite">
          {preview
            ? usableSelection.length > 0
              ? `${t("settings.resourceCleanup.selected", { count: usableSelection.length })} · ${t("settings.resourceCleanup.totalEstimate", { bytes: formatBytes(selectedBytes) })}`
              : t("settings.resourceCleanup.noSelection")
            : null}
        </span>
      </div>

      {preview && expired && (
        <div className="setting-note resource-cleanup-error" role="alert">
          {t("settings.resourceCleanup.expired")}
        </div>
      )}
      {preview && usableSelection.length === 0 && !expired && (
        <div className="setting-note">{t("settings.resourceCleanup.noSelection")}</div>
      )}

      {confirming && preview && !expired && (
        <div className="panel-block resource-cleanup-confirm" role="group" aria-labelledby="resource-cleanup-confirm-title">
          <div className="resource-cleanup-confirm-title" id="resource-cleanup-confirm-title">
            <AlertTriangle size={14} aria-hidden="true" />
            {t("settings.resourceCleanup.confirmPrompt", { bytes: formatBytes(selectedBytes) })}
          </div>
          <div className="resource-cleanup-confirm-list">
            {usableSelection.map((category, index) => (
              <span key={category}>
                {index > 0 && t("settings.resourceCleanup.categorySeparator")}
                {categoryName(category)}
              </span>
            ))}
          </div>
          <div className="resource-cleanup-actions">
            <button className="btn sm" type="button" onClick={() => setConfirming(false)} disabled={busy}>
              {t("settings.resourceCleanup.cancel")}
            </button>
            <button className="btn sm" type="button" onClick={() => void execute()} disabled={busy || usableSelection.length === 0}>
              {phase === "cleaning" ? t("settings.resourceCleanup.cleaning") : t("settings.resourceCleanup.confirm")}
            </button>
          </div>
        </div>
      )}

      {phase === "cleaning" && (
        <div className="setting-note" role="status">
          {t("settings.resourceCleanup.cleaning")}
        </div>
      )}

      {report && (
        <section className="panel-block resource-cleanup-result" aria-live="polite" aria-labelledby="resource-cleanup-result-title">
          <h3 id="resource-cleanup-result-title">{t("settings.resourceCleanup.resultTitle")}</h3>
          <p>
            {report.status === "success"
              ? t("settings.resourceCleanup.resultSuccess", {
                  bytes: formatBytes(report.totalFreedBytes),
                  files: report.totalDeletedFiles,
                })
              : report.status === "partial"
                ? t("settings.resourceCleanup.resultPartial", {
                    bytes: formatBytes(report.totalFreedBytes),
                    files: report.totalDeletedFiles,
                  })
                : t("settings.resourceCleanup.resultFailed")}
          </p>
          <ul>
            {report.categories.map((result) => (
              <li key={result.category}>
                <strong>{categoryName(result.category)}</strong>
                {` · ${t("settings.resourceCleanup.status." + result.status as MessageKey)}`}
                {` · ${t("settings.resourceCleanup.deleted", { count: result.deletedFiles })}`}
                {` · ${t("settings.resourceCleanup.skipped", { count: result.skippedFiles })}`}
                {` · ${t("settings.resourceCleanup.failed", { count: result.failedFiles })}`}
                {` · ${formatBytes(result.freedBytes)}`}
                {result.errorCode && (
                  <span className="resource-cleanup-error"> · {t(errorKey(result.errorCode))}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      </section>

      <p className="setting-note resource-management-safety">
        {t("settings.resourceCleanup.safetyNote")}
      </p>
    </div>
  );
}
