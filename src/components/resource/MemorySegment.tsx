//! 内存分区：系统/应用内存口径 + 可回收缓存与真实释放。
//!
//! 产品边界：
//! - 不调用 Windows 工作集裁剪、不强制 GC、不结束进程；
//! - 只释放本应用自己持有、可按需重建的缓存，并返回**实际**释放字节；
//! - 释放文案是「清空应用内存缓存」，不等于系统可用内存增加相同容量；
//! - 没有可释放对象时不显示「一键释放」，只显示「当前没有可安全释放的应用缓存」；
//! - 工作集 / 私有内存 / WebView2 是三个**不同口径**，不做加起来等于 100% 的堆叠图。
//!
//! 目录读取走 `useAsyncResource`：StrictMode 双挂载复用同一在途请求，
//! 不会被「忙碌」标志拦成永久 pending（根因见 `lib/asyncResource`）。

import { useEffect, useRef, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import {
  resourceMemoryCatalog,
  resourceMemoryRelease,
  type ResourceMemoryReleaseReport,
  type ResourceProcessDiagnostics,
  type ResourceSnapshot,
} from "../../lib/bridge";
import { useAsyncResource } from "../../lib/asyncResource";
import { formatBytes } from "../../lib/clipboardUi";
import { localizedErrorMessage } from "../../i18n/errors";
import { buildBreakdown, computeUsage, formatPercent } from "../../lib/resourceMetrics";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import {
  ChartSwatch,
  StackedBar,
  USAGE_ANOMALY_DETAIL,
  UsageBar,
  usageStatusKey,
} from "./charts";

const SOURCE_LABELS: Record<string, MessageKey> = {
  tts_memory: "resource.memory.source.tts",
  app_icons: "resource.memory.source.icons",
};

interface MemorySegmentProps {
  snapshot: ResourceSnapshot | null;
  snapshotLoading: boolean;
  processes: ResourceProcessDiagnostics | null;
  processesLoading: boolean;
  /** 进程诊断读取失败：WebView2 指标显示未知 + 可重试，不保留旧值冒充新值。 */
  processesError: string | null;
  onLoadProcesses: () => void;
  onRefreshSnapshot: () => void;
  /** 页面级刷新信号：只在本分区可见时递增，切换分区不会误触发。 */
  refreshSignal: number;
}

export default function MemorySegment({
  snapshot,
  snapshotLoading,
  processes,
  processesLoading,
  processesError,
  onLoadProcesses,
  onRefreshSnapshot,
  refreshSignal,
}: MemorySegmentProps) {
  const { t } = useLocale();
  const catalog = useAsyncResource("resource:memoryCatalog", resourceMemoryCatalog);
  const [releasing, setReleasing] = useState(false);
  /** 同步锁：同一 tick 内的双击不会等 React 状态刷新，必须用 ref 兜住。 */
  const releaseBusyRef = useRef(false);
  const [released, setReleased] = useState<ResourceMemoryReleaseReport | null>(null);
  /** 释放失败只影响「释放」这一操作，不与目录读取错误混用同一条状态。 */
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  /** 进程数据由面板持有：首次进入内存页只请求一次（StrictMode 也不重复）。 */
  const requestedProcessesRef = useRef(false);
  const prevSignalRef = useRef(refreshSignal);
  const { reload: reloadCatalog } = catalog;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (requestedProcessesRef.current) return;
    if (processes || processesLoading) return;
    requestedProcessesRef.current = true;
    onLoadProcesses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 页头刷新：只在本分区处于激活状态时由面板递增，避免隐藏分区被动重扫。 */
  useEffect(() => {
    if (prevSignalRef.current === refreshSignal) return;
    prevSignalRef.current = refreshSignal;
    reloadCatalog();
  }, [refreshSignal, reloadCatalog]);

  /**
   * 释放事务 = IPC 释放 + **重新读取目录**。锁必须覆盖两段：
   * 重新采样完成前 `catalog.data` 还是旧值（可释放量 > 0），若只按 `releasing`
   * 判定，用户在间隙里再点一次就会基于旧数据重复释放。
   *
   * `useAsyncResource.reload()` 的 Promise 在本次请求**结算后**（成功或失败、
   * 状态已提交）resolve，因此这里 await 它：同步锁与按钮忙碌态一起覆盖到
   * 重采样完成，而不是在「释放 IPC 返回」的瞬间就放开。扫描失败由
   * `catalog.error`（带重试入口）呈现，不会被误写成释放失败，释放结果仍按
   * 实际释放字节如实展示。
   */
  const releaseLocked = releasing || catalog.loading;

  async function release() {
    if (releaseBusyRef.current || releaseLocked || !catalog.data || catalog.data.totalBytes === 0) {
      return;
    }
    releaseBusyRef.current = true;
    setReleasing(true);
    setReleased(null);
    setReleaseError(null);
    try {
      let report: ResourceMemoryReleaseReport;
      try {
        report = await resourceMemoryRelease();
      } catch (reason: unknown) {
        // 只有释放 IPC 本身失败才写 releaseError；重采样失败属于读取错误。
        if (mountedRef.current) setReleaseError(localizedErrorMessage(reason));
        return;
      }
      if (!mountedRef.current) return;
      setReleased(report);
      onRefreshSnapshot();
      // 释放后按同一口径重新采样：目录与工作集都可能变化。等待结算保证
      // 「一次用户意图」的事务在重新扫描完成前不会因旧目录再次触发释放。
      await reloadCatalog();
    } finally {
      releaseBusyRef.current = false;
      if (mountedRef.current) setReleasing(false);
    }
  }

  const memory = snapshot?.memory;
  const process = snapshot?.process;
  const usage = computeUsage(memory?.totalBytes ?? null, memory?.availableBytes ?? null);
  const webview = processes?.processes.filter(
    (row) => row.association === "managed_child" && row.name.includes("msedgewebview2"),
  );
  const webviewBytes = webview?.reduce((sum, row) => sum + (row.workingSetBytes ?? 0), 0) ?? null;
  const webviewKnown = webview !== undefined && webview.some((row) => row.workingSetBytes !== null);
  const reclaimed = catalog.data?.totalBytes ?? null;
  /** 首次读取仍在进行：这一格该显示「读取中」，而不是「暂不可用」。 */
  const catalogPending = catalog.loading && !catalog.data;
  const snapshotPending = snapshotLoading && !snapshot;
  /** 进程数据未到（首次请求在途）：WebView2 规模只表达「读取中」。 */
  const processesPending = processesLoading && !processes;
  const reading = t("resource.reading");
  const unavailable = t("settings.resourceCleanup.unavailable");

  /** 先按容量降序，再生成切片：条形分段与图例色块必须同序同色。 */
  const sortedSources = [...(catalog.data?.sources ?? [])].sort(
    (left, right) => right.bytes - left.bytes,
  );
  const catalogSlices = buildBreakdown(
    sortedSources.map((source) => ({ id: source.id, bytes: source.bytes })),
    reclaimed,
  ).map((slice, index) => ({ ...slice, colorIndex: index + 1 }));

  return (
    <div className="resource-memory">
      <h3 className="sr-only">{t("resource.memory.title")}</h3>

      {catalog.error && (
        <div className="setting-note resource-cleanup-error" role="alert">
          {t("resource.memory.failed", { error: catalog.error })}
          <button type="button" className="btn sm" onClick={catalog.reload}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {releaseError && (
        <div className="setting-note resource-cleanup-error" role="alert">
          {t("resource.memory.failed", { error: releaseError })}
          <button
            type="button"
            className="btn sm"
            onClick={() => void release()}
            disabled={releaseLocked || !catalog.data || catalog.data.totalBytes === 0}
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      <section className="resource-memory-system" aria-label={t("resource.memory.systemUsage")}>
        <UsageBar
          usedPercent={snapshotPending ? null : usage.usedPercent}
          level={snapshotPending ? "unknown" : usage.level}
          label={t("resource.memory.systemUsage")}
          value={
            snapshotPending
              ? reading
              : `${formatPercent(usage.usedPercent) ?? unavailable} · ${t(
                  usageStatusKey(usage.level, usage.anomaly),
                )}`
          }
          ariaLabel={t("resource.aria.memoryBar", {
            percent: formatPercent(usage.usedPercent) ?? unavailable,
            available:
              usage.availableBytes === null ? unavailable : formatBytes(usage.availableBytes),
            total: usage.totalBytes === null ? unavailable : formatBytes(usage.totalBytes),
            level: t(usageStatusKey(usage.level, usage.anomaly)),
          })}
          detail={
            usage.anomaly
              ? t(USAGE_ANOMALY_DETAIL[usage.anomaly])
              : usage.totalBytes === null
                ? unavailable
                : t("settings.resourceCleanup.memoryValue", {
                    available:
                      usage.availableBytes === null
                        ? unavailable
                        : formatBytes(usage.availableBytes),
                    total: formatBytes(usage.totalBytes),
                  })
          }
        />
      </section>

      {/* 三个应用内存口径互不互斥：并列展示，不做堆叠图。 */}
      <div className="resource-metric-strip resource-memory-metrics">
        <div className="resource-metric">
          <span className="resource-overview-label">{t("resource.memory.workingSet")}</span>
          <strong className="resource-metric-value">
            {snapshotPending
              ? reading
              : process?.workingSetBytes === null || process?.workingSetBytes === undefined
                ? unavailable
                : formatBytes(process.workingSetBytes)}
          </strong>
          <span className="resource-metric-sub">{t("resource.memory.workingSetNote")}</span>
        </div>
        <div className="resource-metric">
          <span className="resource-overview-label">{t("resource.memory.private")}</span>
          <strong className="resource-metric-value">
            {snapshotPending
              ? reading
              : process?.privateBytes === null || process?.privateBytes === undefined
                ? unavailable
                : formatBytes(process.privateBytes)}
          </strong>
          <span className="resource-metric-sub">{t("resource.memory.privateNote")}</span>
        </div>
        <div className="resource-metric">
          <span className="resource-overview-label">{t("resource.memory.webview")}</span>
          <strong className="resource-metric-value">
            {processesPending
              ? reading
              : processesError || !webviewKnown || webviewBytes === null
                ? unavailable
                : formatBytes(webviewBytes)}
          </strong>
          <span className="resource-metric-sub">
            {processesError
              ? t("resource.memory.webviewFailed")
              : webview
                ? t("resource.memory.webviewCount", { count: webview.length })
                : processesPending
                  ? reading
                  : t("resource.memory.webviewPending")}
          </span>
          {processesError && (
            <button type="button" className="resource-link-btn" onClick={onLoadProcesses}>
              {t("common.retry")}
            </button>
          )}
        </div>
      </div>

      <section
        className="resource-memory-release resource-anchor"
        data-resource-anchor="reclaim"
        aria-labelledby="resource-memory-release-title"
      >
        <div className="resource-cleanup-section-head">
          <h3
            className="resource-cleanup-heading resource-anchor-heading"
            id="resource-memory-release-title"
            data-resource-anchor-focus
            tabIndex={-1}
          >
            {t("resource.memory.reclaimable")}
          </h3>
          {reclaimed !== null && (
            <strong className="resource-memory-total">{formatBytes(reclaimed)}</strong>
          )}
        </div>
        <p className="resource-memory-boundary">
          <ShieldCheck size={12} aria-hidden="true" />
          {t("resource.memory.releaseBoundary")}
        </p>

        {catalogPending && (
          <p className="setting-note" role="status">
            {t("resource.reading")}
          </p>
        )}
        {/* 刷新中沿用旧目录避免闪烁，但明说这是上次结果；释放按钮已按锁禁用。 */}
        {catalog.loading && catalog.data && (
          <p className="setting-note" role="status">
            {t("resource.updating")}
          </p>
        )}

        {catalog.data && catalog.data.totalBytes > 0 && (
          <>
            <StackedBar
              slices={catalogSlices}
              ariaLabel={t("resource.aria.reclaim", {
                total: formatBytes(catalog.data.totalBytes),
              })}
              emptyLabel={t("resource.memory.nothingToRelease")}
            />
            <ul className="resource-storage-list">
              {sortedSources.map((source, index) => {
                const percent = catalogSlices[index]?.percent ?? null;
                return (
                  <li className="resource-storage-row" key={source.id}>
                    <ChartSwatch colorIndex={index + 1} />
                    <span className="resource-storage-name">
                      {SOURCE_LABELS[source.id] ? t(SOURCE_LABELS[source.id]) : source.id}
                    </span>
                    <span className="resource-storage-share">
                      {source.bytes === 0 || percent === null
                        ? "—"
                        : t("resource.memory.reclaimShare", { percent: formatPercent(percent) ?? "—" })}
                    </span>
                    <span className="resource-storage-meta">
                      {source.status === "empty"
                        ? t("resource.memory.sourceEmpty")
                        : `${formatBytes(source.bytes)} · ${t("resource.memory.sourceEntries", {
                            count: source.entries,
                          })}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {catalog.data && catalog.data.totalBytes === 0 && (
          <div className="resource-memory-empty" role="status">
            <ShieldCheck size={14} aria-hidden="true" />
            <div>
              <strong>{t("resource.memory.nothingToRelease")}</strong>
              <span>{t("resource.memory.reclaimableDesc")}</span>
            </div>
          </div>
        )}

        {catalog.data && catalog.data.totalBytes > 0 && (
          <div className="resource-cleanup-actions">
            <button
              type="button"
              className="btn sm"
              onClick={() => void release()}
              /* 锁覆盖「释放 + 重新读目录」：重新采样期间旧目录仍显示可释放量，
                 但绝不能据此再次释放（一次用户意图只执行一次）。 */
              disabled={releaseLocked}
            >
              <RefreshCw
                size={12}
                className={releaseLocked ? "spin" : undefined}
                aria-hidden="true"
              />{" "}
              {t(releasing ? "resource.memory.releasing" : "resource.memory.release")}
            </button>
            <span className="resource-cleanup-selection-summary">
              {t("resource.memory.releaseScope")}
            </span>
          </div>
        )}

        {released && (
          <div className="panel-block resource-cleanup-result" aria-live="polite">
            <p>
              {released.releasedBytes > 0
                ? t("resource.memory.released", { bytes: formatBytes(released.releasedBytes) })
                : t("resource.memory.releasedNothing")}
            </p>
            {released.releasedBytes > 0 && catalog.data && (
              <p className="resource-memory-remaining" role="status">
                {catalog.loading
                  ? t("resource.memory.releasedMeasuring")
                  : t("resource.memory.releasedRemaining", {
                      bytes: formatBytes(catalog.data.totalBytes),
                    })}
              </p>
            )}
            <ul>
              {released.sources.map((source) => (
                <li key={source.id}>
                  {SOURCE_LABELS[source.id] ? t(SOURCE_LABELS[source.id]) : source.id}
                  {` · ${formatBytes(source.bytes)} · ${t("resource.memory.sourceEntries", {
                    count: source.entries,
                  })}`}
                </li>
              ))}
            </ul>
            <p className="setting-note">{t("resource.memory.releaseNote")}</p>
          </div>
        )}

        <details className="resource-memory-more">
          <summary>{t("resource.memory.details")}</summary>
          <p>{t("resource.memory.reclaimableDesc")}</p>
          <p>{t("resource.memory.reclaimShareNote")}</p>
          <p>{t("resource.memory.safetyNote")}</p>
        </details>
      </section>
    </div>
  );
}
