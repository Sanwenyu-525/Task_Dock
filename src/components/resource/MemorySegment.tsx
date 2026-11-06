//! 内存分区：系统/应用内存口径 + 可回收缓存与真实释放。
//!
//! 产品边界：
//! - 不调用 Windows 工作集裁剪、不强制 GC、不结束进程；
//! - 只释放本应用自己持有、可按需重建的缓存，并返回**实际**释放字节；
//! - 没有可释放对象时不显示「一键释放」，只显示「当前没有可安全释放的应用缓存」；
//! - WebView2 子进程内存是各进程工作集之和，共享页可能重复计数，只作规模参考。

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  resourceMemoryCatalog,
  resourceMemoryRelease,
  type ResourceMemoryCatalog,
  type ResourceMemoryReleaseReport,
  type ResourceProcessDiagnostics,
  type ResourceSnapshot,
} from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { localizedErrorMessage } from "../../i18n/errors";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";

const SOURCE_LABELS: Record<string, MessageKey> = {
  tts_memory: "resource.memory.source.tts",
  app_icons: "resource.memory.source.icons",
};

interface MemorySegmentProps {
  snapshot: ResourceSnapshot | null;
  snapshotLoading: boolean;
  processes: ResourceProcessDiagnostics | null;
  processesLoading: boolean;
  onLoadProcesses: () => void;
  onRefreshSnapshot: () => void;
}

export default function MemorySegment({
  snapshot,
  snapshotLoading,
  processes,
  processesLoading,
  onLoadProcesses,
  onRefreshSnapshot,
}: MemorySegmentProps) {
  const { t } = useLocale();
  const [catalog, setCatalog] = useState<ResourceMemoryCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [released, setReleased] = useState<ResourceMemoryReleaseReport | null>(null);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const busyRef = useRef(false);

  async function loadCatalog() {
    if (busyRef.current) return;
    busyRef.current = true;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await resourceMemoryCatalog();
      if (!mountedRef.current || request !== requestRef.current) return;
      setCatalog(result);
    } catch (reason: unknown) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setCatalog(null);
      setError(localizedErrorMessage(reason));
    } finally {
      busyRef.current = false;
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void loadCatalog();
    // WebView2 子进程数据与进程分区共用：首次进入内存页时按需取一次。
    if (!processes && !processesLoading) onLoadProcesses();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function release() {
    if (releasing || !catalog || catalog.totalBytes === 0) return;
    setReleasing(true);
    setReleased(null);
    setError(null);
    try {
      const report = await resourceMemoryRelease();
      if (!mountedRef.current) return;
      setReleased(report);
      // 释放后按同一口径重新采样：目录与工作集都可能变化。
      await loadCatalog();
      if (mountedRef.current) onRefreshSnapshot();
    } catch (reason: unknown) {
      if (!mountedRef.current) return;
      setError(localizedErrorMessage(reason));
    } finally {
      if (mountedRef.current) setReleasing(false);
    }
  }

  const memory = snapshot?.memory;
  const process = snapshot?.process;
  const webview = processes?.processes.filter(
    (row) => row.association === "managed_child" && row.name.includes("msedgewebview2"),
  );
  const webviewBytes = webview?.reduce((sum, row) => sum + (row.workingSetBytes ?? 0), 0) ?? null;
  const webviewKnown = webview !== undefined && webview.some((row) => row.workingSetBytes !== null);
  const reclaimed = catalog?.totalBytes ?? null;

  return (
    <div className="resource-memory">
      <div className="resource-cleanup-section-head">
        <h3 className="resource-cleanup-heading">{t("resource.memory.title")}</h3>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            void loadCatalog();
            onRefreshSnapshot();
          }}
          disabled={loading || snapshotLoading}
        >
          <RefreshCw
            size={12}
            className={loading || snapshotLoading ? "spin" : undefined}
            aria-hidden="true"
          />{" "}
          {t("resource.memory.refresh")}
        </button>
      </div>

      {error && (
        <div className="setting-note resource-cleanup-error" role="alert">
          {t("resource.memory.failed", { error })}
        </div>
      )}

      <div className="resource-overview-grid">
        <div className="resource-overview-card">
          <span className="resource-overview-label">{t("settings.resourceCleanup.memory")}</span>
          <strong className="resource-overview-value">
            {memory && memory.totalBytes !== null && memory.availableBytes !== null
              ? formatBytes(memory.availableBytes)
              : t("settings.resourceCleanup.unavailable")}
          </strong>
          <span className="resource-overview-sub">
            {memory && memory.totalBytes !== null
              ? t("resource.memory.systemTotal", { total: formatBytes(memory.totalBytes) })
              : t("settings.resourceCleanup.unavailable")}
          </span>
        </div>
        <div className="resource-overview-card">
          <span className="resource-overview-label">{t("resource.memory.workingSet")}</span>
          <strong className="resource-overview-value">
            {process?.workingSetBytes === null || process?.workingSetBytes === undefined
              ? t("settings.resourceCleanup.unavailable")
              : formatBytes(process.workingSetBytes)}
          </strong>
          <span className="resource-overview-sub">{t("resource.memory.workingSetNote")}</span>
        </div>
        <div className="resource-overview-card">
          <span className="resource-overview-label">{t("resource.memory.private")}</span>
          <strong className="resource-overview-value">
            {process?.privateBytes === null || process?.privateBytes === undefined
              ? t("settings.resourceCleanup.unavailable")
              : formatBytes(process.privateBytes)}
          </strong>
          <span className="resource-overview-sub">{t("resource.memory.privateNote")}</span>
        </div>
        <div className="resource-overview-card">
          <span className="resource-overview-label">{t("resource.memory.webview")}</span>
          <strong className="resource-overview-value">
            {!webviewKnown || webviewBytes === null
              ? t("settings.resourceCleanup.unavailable")
              : formatBytes(webviewBytes)}
          </strong>
          <span className="resource-overview-sub">
            {webview
              ? t("resource.memory.webviewCount", { count: webview.length })
              : t("resource.memory.webviewPending")}
          </span>
        </div>
      </div>

      <section className="resource-memory-release" aria-labelledby="resource-memory-release-title">
        <div className="resource-cleanup-section-head">
          <h3 className="resource-cleanup-heading" id="resource-memory-release-title">
            {t("resource.memory.reclaimable")}
          </h3>
          {reclaimed !== null && (
            <strong className="resource-memory-total">{formatBytes(reclaimed)}</strong>
          )}
        </div>
        <p className="setting-note">{t("resource.memory.reclaimableDesc")}</p>

        {catalog && (
          <ul className="resource-storage-list">
            {catalog.sources.map((source) => (
              <li className="resource-storage-row" key={source.id}>
                <span className="resource-storage-name">
                  {SOURCE_LABELS[source.id] ? t(SOURCE_LABELS[source.id]) : source.id}
                </span>
                <span className="resource-storage-meta">
                  {source.status === "empty"
                    ? t("resource.memory.sourceEmpty")
                    : `${formatBytes(source.bytes)} · ${t("resource.memory.sourceEntries", {
                        count: source.entries,
                      })}`}
                </span>
              </li>
            ))}
          </ul>
        )}

        {catalog && catalog.totalBytes === 0 && (
          <p className="setting-note" role="status">
            {t("resource.memory.nothingToRelease")}
          </p>
        )}

        {catalog && catalog.totalBytes > 0 && (
          <div className="resource-cleanup-actions">
            <button
              type="button"
              className="btn sm"
              onClick={() => void release()}
              disabled={releasing}
            >
              <RefreshCw size={12} className={releasing ? "spin" : undefined} aria-hidden="true" />{" "}
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
          </div>
        )}

        <p className="setting-note">{t("resource.memory.safetyNote")}</p>
      </section>
    </div>
  );
}
