//! 资源管理 · 概览分区（资源仪表盘）。
//!
//! 只消费面板已经取到的快照、清理预览结果与趋势采样，不自行发起 IPC：
//! 切换分区不会产生额外采样；「可清理量」在磁盘页扫描后同步过来，
//! 未扫描时明确显示「尚未扫描」，不把 0 当作真实可清理量。
//!
//! 2026-11-14 第二轮布局：
//! 1. 紧凑有效性条：状态 + 短时间（完整时区在 Tooltip）；
//! 2. 两张横向主卡：小环 + 已用/剩余，在约 400px 内容区并排；
//! 3. 单行关注摘要，明细按需展开；
//! 4. 2×2 应用指标，突出数值；
//! 5. 紧凑趋势与多卷明细。
//!
//! 磁盘与内存使用同一套 `lib/resourceMetrics` 公式与阈值；CPU 不做压力结论。
//! 跳转使用 `anchors.ts` 的稳定目标，由面板负责滚动与焦点。

import { useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  HardDrive,
} from "lucide-react";
import type { ResourceSnapshot } from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { computeUsage, formatPercent } from "../../lib/resourceMetrics";
import {
  FRESHNESS_LABEL,
  type SnapshotFreshness,
} from "../../lib/resourceFreshness";
import { resourceStamp } from "../../lib/resourceTime";
import type { ResourceTrendPoint } from "../../hooks/useResourceTrend";
import { TREND_CAPACITY, TREND_INTERVAL_MS } from "../../hooks/useResourceTrend";
import type { CleanupEstimate } from "../settings/ResourceCleanupSection";
import { useLocale } from "../../hooks/useLocale";
import type { DiskAnchor } from "./anchors";
import {
  MiniMeter,
  TrendSparkline,
  UsageRing,
  usageStatusKey,
} from "./charts";
import { VOLUME_KIND_KEYS } from "./volumeLabels";

interface OverviewSegmentProps {
  snapshot: ResourceSnapshot | null;
  loading: boolean;
  error: string | null;
  /** 由面板统一判定：数值来自哪次采样、是否仍是当前读数。 */
  freshness: SnapshotFreshness;
  sampledAt: string | null;
  /** 磁盘页的扫描估算状态：已过期/失败/未扫描都不能当成 0 B 显示。 */
  cleanable: CleanupEstimate;
  /** 概览可见期间的有界采样点；`failed` 只表示最近一次采样失败。 */
  trend: { points: ResourceTrendPoint[]; failed: boolean };
  /** 跳转到磁盘分区的指定区块（容量 / 应用缓存清理）。 */
  onOpenDisk: (anchor: DiskAnchor) => void;
  /** 跳转到内存分区的可回收缓存区块。 */
  onOpenMemory: () => void;
  onRefresh: () => void;
}

/** 有效百分比的最小/最大值（null 不参与；不足两个点返回 null）。 */
function percentRange(values: ReadonlyArray<number | null>): { min: number; max: number } | null {
  const valid = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (valid.length < 2) return null;
  return { min: Math.min(...valid), max: Math.max(...valid) };
}

/** 压力等级是否值得在关注摘要里出现（未知/正常不进入）。 */
function isAttention(level: string, anomaly: unknown): boolean {
  return Boolean(anomaly) || level === "attention" || level === "critical";
}

export default function OverviewSegment({
  snapshot,
  loading,
  error,
  freshness,
  sampledAt,
  cleanable,
  trend,
  onOpenDisk,
  onOpenMemory,
  onRefresh,
}: OverviewSegmentProps) {
  const { t } = useLocale();
  const [attentionOpen, setAttentionOpen] = useState(false);
  const unavailable = t("settings.resourceCleanup.unavailable");
  const reading = t("resource.reading");
  const pending = freshness === "pending";
  const noReading = freshness === "failed";

  /** 后端按「数据目录所在卷优先」排序，首项即主盘；其余卷在下方卷条里并列展示。 */
  const disks = snapshot?.disks ?? [];
  const disk = disks[0] ?? null;
  const memory = snapshot?.memory;
  const process = snapshot?.process;
  const diskUsage = computeUsage(disk?.totalBytes ?? null, disk?.availableBytes ?? null);
  const memoryUsage = computeUsage(memory?.totalBytes ?? null, memory?.availableBytes ?? null);

  const percentText = (percent: number | null) => formatPercent(percent);
  /**
   * 紧凑小环只放短数值：读取中用省略号、不可读用「—」，
   * 完整状态在卡片头部的药丸与 aria-label 中，避免长文案撑破圆环。
   */
  const ringValue = (percent: number | null) =>
    pending ? "…" : noReading ? null : percentText(percent);
  const ringStatus = (usage: typeof diskUsage) =>
    pending ? reading : noReading ? unavailable : t(usageStatusKey(usage.level, usage.anomaly));

  const cacheBytes = snapshot?.application.knownCacheBytes ?? null;
  const cacheStatus = snapshot?.application.status ?? null;
  /** 部分统计 + 0 B 不等于「确认没有缓存」；不可用也不能显示成 0。 */
  const cacheIncomplete = cacheStatus === "partial";
  const cacheUnavailable = cacheBytes === null || cacheStatus === "unavailable";
  const cacheValue = pending
    ? reading
    : noReading
      ? unavailable
      : cacheUnavailable
        ? t("resource.overview.cacheUnavailable")
        : cacheIncomplete && cacheBytes === 0
          ? t("resource.overview.cacheZeroPartial")
          : formatBytes(cacheBytes);
  const cacheSub = pending
    ? reading
    : noReading
      ? unavailable
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

  const sampled = resourceStamp(sampledAt ?? snapshot?.sampledAt);

  /** 趋势：末端读数优先于环形（采样可能比随页面加载的快照更新）。 */
  const lastTrend = trend.points[trend.points.length - 1] ?? null;
  const diskTrendPercent = lastTrend?.diskPercent ?? diskUsage.usedPercent;
  const memoryTrendPercent = lastTrend?.memoryPercent ?? memoryUsage.usedPercent;
  const diskRange = percentRange(trend.points.map((point) => point.diskPercent));
  const memoryRange = percentRange(trend.points.map((point) => point.memoryPercent));
  const trendRangeText = (range: { min: number; max: number } | null) =>
    range
      ? t("resource.trend.range", {
          min: formatPercent(range.min) ?? unavailable,
          max: formatPercent(range.max) ?? unavailable,
        })
      : null;
  const trendScopeText = t("resource.trend.scope", {
    seconds: Math.round(TREND_INTERVAL_MS / 1000),
    count: TREND_CAPACITY,
  });
  const trendAria = (title: string, range: { min: number; max: number } | null) =>
    range
      ? t("resource.aria.trend", {
          title,
          count: trend.points.length,
          min: formatPercent(range.min) ?? unavailable,
          max: formatPercent(range.max) ?? unavailable,
        })
      : t("resource.aria.trendSampling", { title, count: trend.points.length });

  /**
   * 关注项只来自已展示的同一份读数：主盘、系统内存、其余卷。
   * 不可读/异常读数单独表达，不混成「正常」。
   */
  const attention: Array<{ key: string; name: string; status: string; level: string }> = [];
  if (!pending && !noReading) {
    if (isAttention(diskUsage.level, diskUsage.anomaly)) {
      attention.push({
        key: "primary-disk",
        name: disk?.volume
          ? t("resource.overview.attentionDisk", { volume: disk.volume })
          : t("resource.overview.diskRingTitle"),
        status: t(usageStatusKey(diskUsage.level, diskUsage.anomaly)),
        level: diskUsage.anomaly ? "unknown" : diskUsage.level,
      });
    }
    if (isAttention(memoryUsage.level, memoryUsage.anomaly)) {
      attention.push({
        key: "memory",
        name: t("resource.overview.memoryRingTitle"),
        status: t(usageStatusKey(memoryUsage.level, memoryUsage.anomaly)),
        level: memoryUsage.anomaly ? "unknown" : memoryUsage.level,
      });
    }
    disks.slice(1).forEach((item) => {
      const usage = computeUsage(item.totalBytes, item.availableBytes);
      if (!isAttention(usage.level, usage.anomaly)) return;
      attention.push({
        key: `volume-${item.volume}`,
        name: item.volume,
        status: t(usageStatusKey(usage.level, usage.anomaly)),
        level: usage.anomaly ? "unknown" : usage.level,
      });
    });
  }

  /** 主卡放「已用 / 剩余 / 总量」三行：英文与长数字也不会被脚注截断。 */
  const factsFor = (usage: typeof diskUsage) => [
    {
      key: "used",
      label: t("resource.overview.factUsed"),
      value: usage.usedBytes === null ? unavailable : formatBytes(usage.usedBytes),
    },
    {
      key: "free",
      label: t("resource.overview.factFree"),
      value:
        usage.availableBytes === null
          ? unavailable
          : formatBytes(usage.availableBytes),
    },
    {
      key: "total",
      label: t("resource.overview.factTotal"),
      value: usage.totalBytes === null ? unavailable : formatBytes(usage.totalBytes),
    },
  ];

  const diskSubject = disk
    ? `${disk.volume} · ${t(VOLUME_KIND_KEYS[disk.kind] ?? VOLUME_KIND_KEYS.unknown)}`
    : t("resource.overview.diskRingTitle");
  const memorySubject = t("settings.resourceCleanup.systemScope");

  return (
    <div className="resource-overview">
      {error && (
        <div className="setting-note resource-cleanup-error" role="alert">
          {t("settings.resourceCleanup.snapshotFailed", { error })}
          <button type="button" className="btn sm" onClick={onRefresh} disabled={loading}>
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* 有效性条：数字与可信度一起出现，避免「旧读数看起来像当前值」。 */}
      <div
        className={`resource-freshness is-${freshness}`}
        role="status"
        aria-live="polite"
        data-tip={sampled?.full}
      >
        <span className="resource-freshness-dot" aria-hidden="true" />
        <span className="resource-freshness-label">{t(FRESHNESS_LABEL[freshness])}</span>
        <span className="resource-freshness-time">
          {sampled
            ? t("resource.time.updated", { time: sampled.time })
            : t("settings.resourceCleanup.sampledAtUnknown")}
        </span>
      </div>

      <div className="resource-dashboard">
        <article className={`resource-hero-card is-${diskUsage.level}`}>
          <header className="resource-hero-head">
            <div className="resource-hero-heading">
              <span className="resource-hero-title">{t("resource.overview.diskRingTitle")}</span>
              <span className="resource-hero-subject" data-tip={diskSubject}>
                {diskSubject}
              </span>
            </div>
            <span className={`resource-status-pill is-${diskUsage.anomaly ? "unknown" : diskUsage.level}`}>
              {ringStatus(diskUsage)}
            </span>
          </header>
          <div className="resource-hero-body">
            <UsageRing
              compact
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
            />
            <dl className="resource-hero-facts">
              {factsFor(diskUsage).map((fact) => (
                <div key={fact.key}>
                  <dt>{fact.label}</dt>
                  <dd>{pending || noReading ? (pending ? reading : unavailable) : fact.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <footer className="resource-hero-foot">
            <button
              type="button"
              className="resource-hero-link"
              onClick={() => onOpenDisk("volumes")}
            >
              <HardDrive size={12} aria-hidden="true" />
              {t("resource.overview.openVolumes")}
              <ArrowUpRight size={12} aria-hidden="true" />
            </button>
          </footer>
        </article>

        <article className={`resource-hero-card is-${memoryUsage.level}`}>
          <header className="resource-hero-head">
            <div className="resource-hero-heading">
              <span
                className="resource-hero-title"
                data-tip={memorySubject}
              >
                {t("resource.overview.memoryRingTitle")}
              </span>
            </div>
            <span className={`resource-status-pill is-${memoryUsage.anomaly ? "unknown" : memoryUsage.level}`}>
              {ringStatus(memoryUsage)}
            </span>
          </header>
          <div className="resource-hero-body">
            <UsageRing
              compact
              usedPercent={memoryUsage.usedPercent}
              level={memoryUsage.level}
              title={t("resource.overview.memoryRingTitle")}
              valueText={ringValue(memoryUsage.usedPercent)}
              statusText={ringStatus(memoryUsage)}
              ariaLabel={t("resource.aria.memoryRing", {
                percent: percentText(memoryUsage.usedPercent) ?? unavailable,
                level: t(usageStatusKey(memoryUsage.level, memoryUsage.anomaly)),
              })}
            />
            <dl className="resource-hero-facts">
              {factsFor(memoryUsage).map((fact) => (
                <div key={fact.key}>
                  <dt>{fact.label}</dt>
                  <dd>{pending || noReading ? (pending ? reading : unavailable) : fact.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <footer className="resource-hero-foot">
            <button
              type="button"
              className="resource-hero-link"
              onClick={onOpenMemory}
            >
              <HardDrive size={12} aria-hidden="true" />
              {t("resource.overview.openMemory")}
              <ArrowUpRight size={12} aria-hidden="true" />
            </button>
          </footer>
        </article>
      </div>

      {/* 关注摘要：默认一行，按需展开；名称与状态都来自同一份真实读数。 */}
      {!pending && !noReading && (
        <div
          className={`resource-attention${attention.length > 0 ? " is-warn" : " is-ok"}${
            attentionOpen ? " is-open" : ""
          }`}
          role="status"
        >
          {attention.length > 0 ? (
            <AlertTriangle size={14} aria-hidden="true" />
          ) : (
            <CheckCircle2 size={14} aria-hidden="true" />
          )}
          <span className="resource-attention-text">
            {attention.length > 0
              ? t(
                  attention.length === 1
                    ? "resource.overview.attentionSummaryOne"
                    : "resource.overview.attentionSummary",
                  { count: attention.length },
                )
              : t("resource.overview.attentionNone")}
          </span>
          {attention.length > 0 && (
            <span className="resource-attention-names">
              {attention
                .map((item) => item.name)
                .join(t("resource.overview.attentionSeparator"))}
            </span>
          )}
          {attention.length > 0 && (
            <button
              type="button"
              className="resource-attention-toggle"
              aria-expanded={attentionOpen}
              aria-label={t("resource.overview.attentionDetailAria")}
              onClick={() => setAttentionOpen((open) => !open)}
            >
              {t(
                attentionOpen
                  ? "resource.overview.attentionCollapse"
                  : "resource.overview.attentionExpand",
              )}
              <ChevronDown
                size={12}
                className={`resource-attention-chevron${attentionOpen ? " is-open" : ""}`}
                aria-hidden="true"
              />
            </button>
          )}
          {attention.length > 0 && attentionOpen && (
            <ul className="resource-attention-detail">
              {attention.map((item) => (
                <li key={item.key}>
                  <span className={`resource-attention-dot is-${item.level}`} aria-hidden="true" />
                  <span className="resource-attention-name">{item.name}</span>
                  <span className={`resource-attention-status is-${item.level}`}>
                    {item.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section className="resource-app-metrics" aria-labelledby="resource-app-metrics-title">
        <div className="resource-section-head">
          <h3 id="resource-app-metrics-title" data-tip={t("resource.overview.metricsNote")}>
            {t("resource.overview.metricsTitle")}
          </h3>
        </div>
        <div className="resource-metric-strip">
          <div className="resource-metric">
            <span className="resource-overview-label">
              {t("settings.resourceCleanup.applicationCache")}
            </span>
            <strong className="resource-metric-value">{cacheValue}</strong>
            <span className="resource-metric-sub" data-tip={cacheSub}>
              {cacheSub}
            </span>
          </div>

          <button
            type="button"
            className="resource-metric resource-metric-action"
            onClick={() => onOpenDisk("app-cache")}
            disabled={pending}
            aria-label={t("resource.overview.cleanableAria")}
          >
            <span className="resource-overview-label">{t("resource.overview.cleanable")}</span>
            <strong className="resource-metric-value">{cleanableValue}</strong>
            <span className="resource-metric-sub" data-tip={cleanableSub}>
              {cleanableSub}
            </span>
            <span className="resource-metric-go" aria-hidden="true">
              {t("resource.overview.cleanableGo")}
              <ArrowUpRight size={12} />
            </span>
          </button>

          <div className="resource-metric">
            <span className="resource-overview-label">{t("resource.overview.appMemory")}</span>
            <strong className="resource-metric-value">
              {pending || noReading
                ? pending
                  ? reading
                  : unavailable
                : process?.workingSetBytes === null || process?.workingSetBytes === undefined
                  ? unavailable
                  : formatBytes(process.workingSetBytes)}
            </strong>
            <span className="resource-metric-sub">
              {pending || noReading
                ? pending
                  ? reading
                  : unavailable
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
              {pending || noReading
                ? pending
                  ? reading
                  : unavailable
                : process?.cpuPercent === null || process?.cpuPercent === undefined
                  ? unavailable
                  : t("settings.resourceCleanup.cpuValue", {
                      percent: process.cpuPercent.toFixed(1),
                    })}
            </strong>
            <span className="resource-metric-sub">
              {pending || noReading
                ? pending
                  ? reading
                  : unavailable
                : process && process.cpuWindowMs > 0
                  ? t("settings.resourceCleanup.cpuWindow", {
                      window: Math.max(1, Math.round(process.cpuWindowMs / 1000)),
                    })
                  : t("settings.resourceCleanup.applicationCpuScope")}
            </span>
            <MiniMeter
              percent={pending || noReading ? null : (process?.cpuPercent ?? null)}
              tone="neutral"
              ariaLabel={t("settings.resourceCleanup.applicationCpu")}
            />
          </div>
        </div>
      </section>

      {/* 短时趋势：概览可见时有界采样；只画真实读数，缺失点断线。 */}
      <section className="resource-trend-section" aria-labelledby="resource-trend-title">
        <div className="resource-section-head">
          <h3 id="resource-trend-title" data-tip={trendScopeText}>
            {t("resource.trend.title")}
          </h3>
        </div>
        <div className="resource-trend">
          <TrendSparkline
            points={trend.points.map((point) => ({ at: point.at, percent: point.diskPercent }))}
            level={diskUsage.level}
            title={t("resource.overview.diskRingTitle")}
            valueText={pending ? reading : (formatPercent(diskTrendPercent) ?? unavailable)}
            statusText={t(usageStatusKey(diskUsage.level, diskUsage.anomaly))}
            emptyText={t("resource.trend.sampling")}
            rangeText={trendRangeText(diskRange)}
            ariaLabel={trendAria(t("resource.overview.diskRingTitle"), diskRange)}
          />
          <TrendSparkline
            points={trend.points.map((point) => ({ at: point.at, percent: point.memoryPercent }))}
            level={memoryUsage.level}
            title={t("resource.overview.memoryRingTitle")}
            valueText={pending ? reading : (formatPercent(memoryTrendPercent) ?? unavailable)}
            statusText={t(usageStatusKey(memoryUsage.level, memoryUsage.anomaly))}
            emptyText={t("resource.trend.sampling")}
            rangeText={trendRangeText(memoryRange)}
            ariaLabel={trendAria(t("resource.overview.memoryRingTitle"), memoryRange)}
          />
        </div>
        {trend.failed && (
          <p className="setting-note resource-trend-failed" role="status">
            {t("resource.trend.failed")}
          </p>
        )}
      </section>

      {/* 多卷：概览除主盘主卡外，用紧凑卷条并列展示其余卷的只读使用率。 */}
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
    </div>
  );
}
