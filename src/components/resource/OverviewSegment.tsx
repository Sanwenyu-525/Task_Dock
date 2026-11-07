//! 资源管理 · 概览分区。
//!
//! 只消费面板已经取到的快照与清理预览结果，不自行发起 IPC：
//! 切换分区不会产生额外采样；「可清理量」在磁盘页扫描后同步过来，
//! 未扫描时明确显示「尚未扫描」，不把 0 当作真实可清理量。
//!
//! 布局：顶部两个大环形（磁盘 / 系统内存，整机口径），下方紧凑指标条
//! （应用缓存、可清理空间、应用内存、应用 CPU）。磁盘与内存使用同一套
//! `lib/resourceMetrics` 公式与阈值；CPU 不做压力结论。

import { HardDrive } from "lucide-react";
import type { ResourceSnapshot } from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { formatLocalStamp } from "../../lib/format";
import { computeUsage, formatPercent, type PressureLevel } from "../../lib/resourceMetrics";
import { useLocale } from "../../hooks/useLocale";
import { MiniMeter, PRESSURE_LEVEL_KEYS, UsageRing } from "./charts";

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
  const reading = t("resource.reading");
  const pending = loading && !snapshot;

  const disk = snapshot?.disks[0] ?? null;
  const memory = snapshot?.memory;
  const process = snapshot?.process;
  const diskUsage = computeUsage(disk?.totalBytes ?? null, disk?.availableBytes ?? null);
  const memoryUsage = computeUsage(memory?.totalBytes ?? null, memory?.availableBytes ?? null);

  const percentText = (percent: number | null) => formatPercent(percent);
  const levelText = (level: keyof typeof PRESSURE_LEVEL_KEYS) => t(PRESSURE_LEVEL_KEYS[level]);
  const ringValue = (percent: number | null) => (pending ? reading : percentText(percent));
  const ringStatus = (level: PressureLevel) => (pending ? reading : levelText(level));

  const cacheBytes = snapshot?.application.knownCacheBytes ?? null;
  const sampled = sampledLabel(snapshot?.sampledAt);

  return (
    <div className="resource-overview">
      <div className="resource-cleanup-section-head">
        <h3 className="resource-cleanup-heading">{t("resource.overview.title")}</h3>
      </div>
      {error && (
        <div className="setting-note resource-cleanup-error" role="alert">
          {t("settings.resourceCleanup.snapshotFailed", { error })}
          <button type="button" className="btn sm" onClick={onRefresh} disabled={loading}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {loading && !snapshot && !error && (
        <p className="setting-note" role="status">
          {t("settings.resourceCleanup.loadingSnapshot")}
        </p>
      )}
      {/* 刷新中保留上次结果以避免闪烁，但必须明说这是旧采样，不是实时指标。 */}
      {loading && snapshot && !error && (
        <p className="setting-note" role="status">
          {t("resource.updating")}
        </p>
      )}

      <div className="resource-usage-hero">
        <UsageRing
          usedPercent={diskUsage.usedPercent}
          level={diskUsage.level}
          title={t("resource.overview.diskRingTitle")}
          valueText={ringValue(diskUsage.usedPercent)}
          statusText={ringStatus(diskUsage.level)}
          ariaLabel={t("resource.aria.diskRing", {
            volume: disk?.volume ?? "",
            percent: percentText(diskUsage.usedPercent) ?? unavailable,
            level: levelText(diskUsage.level),
          })}
          detail={
            <>
              <span>
                {/* 读取尚未完成时显示「读取中」，不能把未加载说成「暂不可用」 */}
                {pending
                  ? reading
                  : diskUsage.usedBytes === null
                    ? unavailable
                    : t("resource.overview.ringUsed", {
                        used: formatBytes(diskUsage.usedBytes),
                      })}
                {disk?.volume ? ` · ${disk.volume}` : ""}
              </span>
              <span>
                {pending
                  ? reading
                  : diskUsage.availableBytes === null || diskUsage.totalBytes === null
                    ? unavailable
                    : `${t("resource.overview.ringFree", {
                        free: formatBytes(diskUsage.availableBytes),
                      })} · ${t("resource.overview.ringTotal", {
                        total: formatBytes(diskUsage.totalBytes),
                      })}`}
              </span>
            </>
          }
        />
        <UsageRing
          usedPercent={memoryUsage.usedPercent}
          level={memoryUsage.level}
          title={t("resource.overview.memoryRingTitle")}
          valueText={ringValue(memoryUsage.usedPercent)}
          statusText={ringStatus(memoryUsage.level)}
          ariaLabel={t("resource.aria.memoryRing", {
            percent: percentText(memoryUsage.usedPercent) ?? unavailable,
            level: levelText(memoryUsage.level),
          })}
          detail={
            <>
              <span>
                {/* 与磁盘环一致：读取中显示「读取中」，不是「暂不可用」 */}
                {pending
                  ? reading
                  : memoryUsage.availableBytes === null || memoryUsage.totalBytes === null
                    ? unavailable
                    : t("settings.resourceCleanup.memoryValue", {
                        available: formatBytes(memoryUsage.availableBytes),
                        total: formatBytes(memoryUsage.totalBytes),
                      })}
              </span>
              <span>{t("settings.resourceCleanup.systemScope")}</span>
            </>
          }
        />
      </div>

      <div className="resource-metric-strip">
        <div className="resource-metric">
          <span className="resource-overview-label">
            {t("settings.resourceCleanup.applicationCache")}
          </span>
          <strong className="resource-metric-value">
            {pending ? reading : cacheBytes === null ? unavailable : formatBytes(cacheBytes)}
          </strong>
          <span className="resource-metric-sub">
            {pending
              ? reading
              : snapshot && snapshot.application.knownCacheFiles !== null
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

        <div className="resource-metric">
          <span className="resource-overview-label">{t("resource.overview.cleanable")}</span>
          <strong className="resource-metric-value">
            {pending
              ? reading
              : cleanableBytes === null
                ? t("resource.overview.cleanableUnknown")
                : formatBytes(cleanableBytes)}
          </strong>
          <span className="resource-metric-sub">
            {pending
              ? reading
              : cleanableBytes === null
                ? t("resource.overview.cacheUnscanned")
                : t("settings.resourceCleanup.estimated", {
                    bytes: formatBytes(cleanableBytes),
                  })}
            {!pending && (
              <button type="button" className="resource-link-btn" onClick={onOpenDisk}>
                <HardDrive size={11} aria-hidden="true" /> {t("resource.overview.scanCache")}
              </button>
            )}
          </span>
        </div>

        <div className="resource-metric">
          <span className="resource-overview-label">{t("resource.overview.appMemory")}</span>
          <strong className="resource-metric-value">
            {pending
              ? reading
              : process?.workingSetBytes === null || process?.workingSetBytes === undefined
                ? unavailable
                : formatBytes(process.workingSetBytes)}
          </strong>
          <span className="resource-metric-sub">
            {pending
              ? reading
              : process?.privateBytes === null || process?.privateBytes === undefined
                ? unavailable
                : t("resource.overview.privateValue", {
                    bytes: formatBytes(process.privateBytes),
                  })}
          </span>
        </div>

        <div className="resource-metric">
          <span className="resource-overview-label">
            {t("settings.resourceCleanup.applicationCpu")}
          </span>
          <strong className="resource-metric-value">
            {pending
              ? reading
              : process?.cpuPercent === null || process?.cpuPercent === undefined
                ? unavailable
                : t("settings.resourceCleanup.cpuValue", {
                    percent: process.cpuPercent.toFixed(1),
                  })}
          </strong>
          <span className="resource-metric-sub">
            {pending
              ? reading
              : process && process.cpuWindowMs > 0
                ? t("settings.resourceCleanup.cpuWindow", {
                    window: Math.max(1, Math.round(process.cpuWindowMs)),
                  })
                : t("settings.resourceCleanup.applicationCpuScope")}
          </span>
          <MiniMeter
            percent={pending ? null : (process?.cpuPercent ?? null)}
            tone="neutral"
            ariaLabel={t("settings.resourceCleanup.applicationCpu")}
          />
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
