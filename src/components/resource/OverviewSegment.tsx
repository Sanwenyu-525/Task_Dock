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
import { computeUsage, formatPercent } from "../../lib/resourceMetrics";
import type { CleanupEstimate } from "../settings/ResourceCleanupSection";
import { useLocale } from "../../hooks/useLocale";
import {
  MiniMeter,
  USAGE_ANOMALY_DETAIL,
  UsageRing,
  usageStatusKey,
} from "./charts";
import { VOLUME_KIND_KEYS } from "./volumeLabels";

interface OverviewSegmentProps {
  snapshot: ResourceSnapshot | null;
  loading: boolean;
  error: string | null;
  /** 磁盘页的扫描估算状态：已过期/失败/未扫描都不能当成 0 B 显示。 */
  cleanable: CleanupEstimate;
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
  cleanable,
  onOpenDisk,
  onRefresh,
}: OverviewSegmentProps) {
  const { t } = useLocale();
  const unavailable = t("settings.resourceCleanup.unavailable");
  const reading = t("resource.reading");
  const pending = loading && !snapshot;

  /** 后端按「数据目录所在卷优先」排序，首项即主盘；其余卷在下方卷条里并列展示。 */
  const disks = snapshot?.disks ?? [];
  const disk = disks[0] ?? null;
  const memory = snapshot?.memory;
  const process = snapshot?.process;
  const diskUsage = computeUsage(disk?.totalBytes ?? null, disk?.availableBytes ?? null);
  const memoryUsage = computeUsage(memory?.totalBytes ?? null, memory?.availableBytes ?? null);

  const percentText = (percent: number | null) => formatPercent(percent);
  const ringValue = (percent: number | null) => (pending ? reading : percentText(percent));
  const ringStatus = (usage: typeof diskUsage) =>
    pending ? reading : t(usageStatusKey(usage.level, usage.anomaly));

  const cacheBytes = snapshot?.application.knownCacheBytes ?? null;
  const cacheStatus = snapshot?.application.status ?? null;
  /** 部分统计 + 0 B 不等于「确认没有缓存」；不可用也不能显示成 0。 */
  const cacheIncomplete = cacheStatus === "partial";
  const cacheUnavailable = cacheBytes === null || cacheStatus === "unavailable";
  const cacheValue = pending
    ? reading
    : cacheUnavailable
      ? t("resource.overview.cacheUnavailable")
      : cacheIncomplete && cacheBytes === 0
        ? t("resource.overview.cacheZeroPartial")
        : formatBytes(cacheBytes);
  const cacheSub = pending
    ? reading
    : [
        cacheUnavailable
          ? t("settings.resourceCleanup.applicationStatus.unavailable")
          : snapshot?.application.knownCacheFiles === null
            ? unavailable
            : t("settings.resourceCleanup.files", {
                count: snapshot?.application.knownCacheFiles ?? 0,
              }),
        cacheIncomplete
          ? t("resource.overview.cachePartialNote")
          : cacheUnavailable
            ? null
            : t("settings.resourceCleanup.applicationStatus.ready"),
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ");

  const cleanableReady =
    (cleanable.state === "ready" || cleanable.state === "partial") &&
    cleanable.totalBytes !== null;
  const cleanableValue = pending
    ? reading
    : cleanableReady
      ? // 部分来源未纳入且已统计 0 B：不能只突出「0 B」让人误读为确认无可清理
        cleanable.state === "partial" && cleanable.totalBytes === 0
        ? t("resource.overview.cleanableZeroPartial")
        : formatBytes(cleanable.totalBytes as number)
      : cleanable.state === "scanning"
        ? t("resource.overview.cleanableScanning")
        : cleanable.state === "stale"
          ? t("resource.overview.cleanableStale")
          : cleanable.state === "failed"
            ? t("resource.overview.cleanableFailed")
            : t("resource.overview.cleanableUnknown");
  const cleanableSub = pending
    ? reading
    : cleanableReady
      ? t(
          cleanable.state === "partial"
            ? "resource.overview.cleanablePartialNote"
            : "resource.overview.cleanableReadyNote",
        )
      : cleanable.state === "scanning"
        ? t("resource.overview.cleanableScanningNote")
        : cleanable.state === "stale"
          ? t("resource.overview.cleanableStaleNote")
          : cleanable.state === "failed"
            ? t("resource.overview.cleanableFailedNote")
            : t("resource.overview.cacheUnscanned");

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
          statusText={ringStatus(diskUsage)}
          ariaLabel={t("resource.aria.diskRing", {
            volume: disk?.volume ?? "",
            percent: percentText(diskUsage.usedPercent) ?? unavailable,
            level: t(usageStatusKey(diskUsage.level, diskUsage.anomaly)),
          })}
          detail={
            <>
              <span>
                {/* 读取尚未完成时显示「读取中」，不能把未加载说成「暂不可用」 */}
                {pending
                  ? reading
                  : diskUsage.anomaly
                    ? t(USAGE_ANOMALY_DETAIL[diskUsage.anomaly])
                    : diskUsage.usedBytes === null
                      ? unavailable
                      : t("resource.overview.ringUsed", {
                          used: formatBytes(diskUsage.usedBytes),
                        })}
                {!diskUsage.anomaly && disk?.volume ? ` · ${disk.volume}` : ""}
              </span>
              <span>
                {pending
                  ? reading
                  : diskUsage.anomaly
                    ? ""
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
          statusText={ringStatus(memoryUsage)}
          ariaLabel={t("resource.aria.memoryRing", {
            percent: percentText(memoryUsage.usedPercent) ?? unavailable,
            level: t(usageStatusKey(memoryUsage.level, memoryUsage.anomaly)),
          })}
          detail={
            <>
              <span>
                {/* 与磁盘环一致：读取中显示「读取中」，不是「暂不可用」 */}
                {pending
                  ? reading
                  : memoryUsage.anomaly
                    ? t(USAGE_ANOMALY_DETAIL[memoryUsage.anomaly])
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

      {/* 多卷：概览除主盘环形外，用紧凑卷条并列展示其余卷的只读使用率。 */}
      {disks.length > 1 && (
        <div className="resource-volume-strip" role="list" aria-label={t("resource.volumes.title")}>
          {disks.map((item) => {
            const usage = computeUsage(item.totalBytes, item.availableBytes);
            const kindKey = VOLUME_KIND_KEYS[item.kind] ?? VOLUME_KIND_KEYS.unknown;
            const status = t(usageStatusKey(usage.level, usage.anomaly));
            const valueText =
              usage.usedPercent === null
                ? status
                : `${formatPercent(usage.usedPercent)} · ${status}`;
            return (
              <div
                className="resource-volume-chip"
                role="listitem"
                key={item.volume}
                data-tip={t(kindKey)}
              >
                <span className="resource-volume-name">{item.volume}</span>
                <span className="resource-volume-value">{pending ? reading : valueText}</span>
                <MiniMeter
                  percent={pending ? null : usage.usedPercent}
                  tone={pending ? "neutral" : usage.level}
                  ariaLabel={t("resource.aria.volumeChip", {
                    volume: item.volume,
                    kind: t(kindKey),
                    percent: formatPercent(usage.usedPercent) ?? unavailable,
                    level: t(usageStatusKey(usage.level, usage.anomaly)),
                  })}
                />
              </div>
            );
          })}
        </div>
      )}

      <div className="resource-metric-strip">
        <div className="resource-metric">
          <span className="resource-overview-label">
            {t("settings.resourceCleanup.applicationCache")}
          </span>
          <strong className="resource-metric-value">{cacheValue}</strong>
          <span className="resource-metric-sub">{cacheSub}</span>
        </div>

        <div className="resource-metric">
          <span className="resource-overview-label">{t("resource.overview.cleanable")}</span>
          <strong className="resource-metric-value">{cleanableValue}</strong>
          <span className="resource-metric-sub">
            {cleanableSub}
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
