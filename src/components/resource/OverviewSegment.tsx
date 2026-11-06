//! 资源管理 · 概览分区。
//!
//! 只消费面板已经取到的快照与清理预览结果，不自行发起 IPC：
//! 切换分区不会产生额外采样；「可清理量」在磁盘页扫描后同步过来，
//! 未扫描时明确显示「扫描后显示」，不把 0 当作真实可清理量。

import { HardDrive } from "lucide-react";
import type { ResourceSnapshot } from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { formatLocalStamp } from "../../lib/format";
import { useLocale } from "../../hooks/useLocale";

interface OverviewSegmentProps {
  snapshot: ResourceSnapshot | null;
  loading: boolean;
  error: string | null;
  /** 磁盘页最近一次扫描得到的可清理字节；null = 尚未扫描。 */
  cleanableBytes: number | null;
  /** 跳转到磁盘分区（扫描入口在那里）。 */
  onOpenDisk: () => void;
  onRefresh: () => void;
}

function sampledLabel(iso: string | null | undefined): string | null {
  const stamp = formatLocalStamp(iso);
  return stamp ? `${stamp.date} ${stamp.time} ${stamp.zone}` : null;
}

export default function OverviewSegment({
  snapshot,
  loading,
  error,
  cleanableBytes,
  onOpenDisk,
  onRefresh,
}: OverviewSegmentProps) {
  const { t } = useLocale();
  const unavailable = t("settings.resourceCleanup.unavailable");
  const disk = snapshot?.disks[0] ?? null;
  const memory = snapshot?.memory;
  const process = snapshot?.process;

  const diskUsed =
    disk && disk.totalBytes !== null && disk.availableBytes !== null
      ? disk.totalBytes - disk.availableBytes
      : null;
  const cacheBytes = snapshot?.application.knownCacheBytes ?? null;
  const sampled = sampledLabel(snapshot?.sampledAt);

  return (
    <div className="resource-overview">
      <div className="resource-cleanup-section-head">
        <h3 className="resource-cleanup-heading">{t("resource.overview.title")}</h3>
        <button type="button" className="btn sm" onClick={onRefresh} disabled={loading}>
          {t(loading ? "settings.resourceCleanup.refreshing" : "settings.resourceCleanup.refresh")}
        </button>
      </div>
      {error && (
        <div className="setting-note resource-cleanup-error" role="alert">
          {t("settings.resourceCleanup.snapshotFailed", { error })}
        </div>
      )}
      {loading && !snapshot && !error && (
        <p className="setting-note" role="status">
          {t("settings.resourceCleanup.loadingSnapshot")}
        </p>
      )}

      <div className="resource-overview-grid">
        <div className="resource-overview-card">
          <span className="resource-overview-label">{t("resource.overview.disk")}</span>
          <strong className="resource-overview-value">
            {disk && disk.totalBytes !== null
              ? t("resource.overview.diskTotal", { total: formatBytes(disk.totalBytes) })
              : unavailable}
          </strong>
          <span className="resource-overview-sub">
            {disk && disk.availableBytes !== null && diskUsed !== null
              ? t("resource.overview.diskSplit", {
                  used: formatBytes(diskUsed),
                  free: formatBytes(disk.availableBytes),
                })
              : unavailable}
            {disk ? ` · ${disk.volume}` : ""}
          </span>
        </div>

        <div className="resource-overview-card">
          <span className="resource-overview-label">{t("settings.resourceCleanup.applicationCache")}</span>
          <strong className="resource-overview-value">
            {cacheBytes === null ? unavailable : formatBytes(cacheBytes)}
          </strong>
          <span className="resource-overview-sub">
            {snapshot && snapshot.application.knownCacheFiles !== null
              ? t("settings.resourceCleanup.files", {
                  count: snapshot.application.knownCacheFiles,
                })
              : unavailable}
            {snapshot
              ? ` · ${t(
                  snapshot.application.status === "ready"
                    ? "settings.resourceCleanup.applicationStatus.ready"
                    : snapshot.application.status === "partial"
                      ? "settings.resourceCleanup.applicationStatus.partial"
                      : "settings.resourceCleanup.applicationStatus.unavailable",
                )}`
              : ""}
          </span>
        </div>

        <div className="resource-overview-card">
          <span className="resource-overview-label">{t("resource.overview.cleanable")}</span>
          <strong className="resource-overview-value">
            {cleanableBytes === null
              ? t("resource.overview.cleanableUnknown")
              : formatBytes(cleanableBytes)}
          </strong>
          <span className="resource-overview-sub">
            <button type="button" className="resource-link-btn" onClick={onOpenDisk}>
              <HardDrive size={11} aria-hidden="true" /> {t("resource.overview.openDisk")}
            </button>
          </span>
        </div>

        <div className="resource-overview-card">
          <span className="resource-overview-label">{t("settings.resourceCleanup.memory")}</span>
          <strong className="resource-overview-value">
            {memory && memory.totalBytes !== null && memory.availableBytes !== null
              ? t("settings.resourceCleanup.memoryValue", {
                  available: formatBytes(memory.availableBytes),
                  total: formatBytes(memory.totalBytes),
                })
              : unavailable}
          </strong>
          <span className="resource-overview-sub">{t("settings.resourceCleanup.systemScope")}</span>
        </div>

        <div className="resource-overview-card">
          <span className="resource-overview-label">{t("resource.overview.appMemory")}</span>
          <strong className="resource-overview-value">
            {process?.workingSetBytes === null || process?.workingSetBytes === undefined
              ? unavailable
              : formatBytes(process.workingSetBytes)}
          </strong>
          <span className="resource-overview-sub">
            {process?.privateBytes === null || process?.privateBytes === undefined
              ? unavailable
              : t("resource.overview.privateValue", {
                  bytes: formatBytes(process.privateBytes),
                })}
          </span>
        </div>

        <div className="resource-overview-card">
          <span className="resource-overview-label">{t("settings.resourceCleanup.applicationCpu")}</span>
          <strong className="resource-overview-value">
            {process?.cpuPercent === null || process?.cpuPercent === undefined
              ? unavailable
              : t("settings.resourceCleanup.cpuValue", {
                  percent: process.cpuPercent.toFixed(1),
                })}
          </strong>
          <span className="resource-overview-sub">
            {process && process.cpuWindowMs > 0
              ? t("settings.resourceCleanup.cpuWindow", {
                  window: Math.max(1, Math.round(process.cpuWindowMs)),
                })
              : t("settings.resourceCleanup.applicationCpuScope")}
          </span>
        </div>
      </div>

      <div className="resource-overview-footer">
        <span>
          {sampled
            ? t("settings.resourceCleanup.sampledAt", { time: sampled })
            : t("settings.resourceCleanup.sampledAtUnknown")}
        </span>
        <span className="resource-overview-scope-note">
          {t("resource.overview.scopeNote")}
        </span>
      </div>
    </div>
  );
}
