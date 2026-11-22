//! 资源管理图表基元：环形使用率、横向进度条、占比条、迷你条。
//!
//! 约束：
//! - 纯 CSS + SVG 静态绘制，无 Canvas、无 requestAnimationFrame、无持续动画；
//! - 百分比由 `lib/resourceMetrics` 统一计算，组件只负责映射到几何与状态色；
//! - 颜色走 `.resource-page` 作用域的语义 Token（`--chart-*`），深浅主题各自可读；
//! - `null` 百分比表示不可读：不画进度、不显示 0%，由调用方给「暂不可用」文案。

import type { ReactNode } from "react";
import type { PressureLevel, UsageAnomaly } from "../../lib/resourceMetrics";
import type { MessageKey } from "../../i18n";

/** 压力等级 → i18n Key：概览/磁盘/内存共用同一套文案。 */
export const PRESSURE_LEVEL_KEYS: Record<PressureLevel, MessageKey> = {
  normal: "resource.level.normal",
  attention: "resource.level.attention",
  critical: "resource.level.critical",
  unknown: "resource.level.unknown",
};

/** 读数异常 → 状态文案：优先于等级文案，避免把矛盾读数说成「暂不可用」而不说明原因。 */
const USAGE_ANOMALY_STATUS: Record<UsageAnomaly, MessageKey> = {
  available_exceeds_total: "resource.level.anomaly",
};

/** 读数异常 → 详细说明（图表下方/aria 使用）。 */
export const USAGE_ANOMALY_DETAIL: Record<UsageAnomaly, MessageKey> = {
  available_exceeds_total: "resource.anomaly.availableExceedsTotal",
};

/** 图表状态文案：异常优先，其次才是压力等级。 */
export function usageStatusKey(
  level: PressureLevel,
  anomaly: UsageAnomaly | null | undefined,
): MessageKey {
  if (anomaly) return USAGE_ANOMALY_STATUS[anomaly];
  return PRESSURE_LEVEL_KEYS[level];
}

const LEVEL_CLASS: Record<PressureLevel, string> = {
  normal: "is-normal",
  attention: "is-attention",
  critical: "is-critical",
  unknown: "is-unknown",
};

/** 环形半径与周长：几何常量集中在此，测试据此校验弧度与百分比一致。 */
export const RING_RADIUS = 52;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export interface UsageRingProps {
  /** 0–100；null = 不可读。 */
  usedPercent: number | null;
  level: PressureLevel;
  /** 图表下方的标题（如「磁盘」）。 */
  title: string;
  /** 中心大号数值（如 `89.3%`）；不可读时传 null。 */
  valueText: string | null;
  /** 状态文字（正常 / 关注 / 紧张 / 暂不可用）。 */
  statusText: string;
  /** 屏幕阅读器完整描述。 */
  ariaLabel: string;
  /** 图表下方的两行辅助信息。 */
  detail?: ReactNode;
  /** 紧凑变体：只保留小环 + 中心数值，标题/状态由外层卡片头承担。 */
  compact?: boolean;
}

export function UsageRing({
  usedPercent,
  level,
  title,
  valueText,
  statusText,
  ariaLabel,
  detail,
  compact = false,
}: UsageRingProps) {
  const percent = usedPercent === null ? null : Math.min(100, Math.max(0, usedPercent));
  const offset = percent === null ? RING_CIRCUMFERENCE : RING_CIRCUMFERENCE * (1 - percent / 100);
  return (
    <figure
      className={`resource-ring ${LEVEL_CLASS[level]}${compact ? " is-compact" : ""}`}
      role="img"
      aria-label={ariaLabel}
    >
      <div className="resource-ring-figure">
        <svg viewBox="0 0 120 120" className="resource-ring-svg" aria-hidden="true" focusable="false">
          <circle className="resource-ring-track" cx="60" cy="60" r={RING_RADIUS} />
          {percent !== null && percent > 0 && (
            <circle
              className="resource-ring-fill"
              cx="60"
              cy="60"
              r={RING_RADIUS}
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={offset}
              transform="rotate(-90 60 60)"
            />
          )}
        </svg>
        <div className="resource-ring-center">
          <strong>{valueText ?? "—"}</strong>
          <span>{statusText}</span>
        </div>
      </div>
      {!compact && (
        <figcaption className="resource-ring-caption">
          <span className="resource-ring-title">{title}</span>
          {detail}
        </figcaption>
      )}
    </figure>
  );
}

export interface UsageBarProps {
  usedPercent: number | null;
  level: PressureLevel;
  /** 左侧标签。 */
  label: ReactNode;
  /** 右侧数值（百分比或容量说明）。 */
  value: ReactNode;
  ariaLabel: string;
  /** 条形高度：页面级用 md，行内用 sm。 */
  size?: "sm" | "md";
  detail?: ReactNode;
}

/** 横向使用率条：磁盘/内存的页面级复用，也可用于单行指标。 */
export function UsageBar({
  usedPercent,
  level,
  label,
  value,
  ariaLabel,
  size = "md",
  detail,
}: UsageBarProps) {
  const percent = usedPercent === null ? null : Math.min(100, Math.max(0, usedPercent));
  return (
    <div className={`resource-bar ${LEVEL_CLASS[level]} size-${size}`} role="img" aria-label={ariaLabel}>
      <div className="resource-bar-head">
        <span className="resource-bar-label">{label}</span>
        <span className="resource-bar-value">{value}</span>
      </div>
      <div className="resource-bar-track">
        {percent !== null && percent > 0 && (
          <span className="resource-bar-fill" style={{ width: `${percent}%` }} />
        )}
      </div>
      {detail && <div className="resource-bar-detail">{detail}</div>}
    </div>
  );
}

/** 迷你条：进程行的 CPU 用；neutral 表示不参与压力配色（CPU 单次采样不下结论）。 */
export function MiniMeter({
  percent,
  tone = "neutral",
  ariaLabel,
}: {
  percent: number | null;
  tone?: PressureLevel | "neutral";
  ariaLabel: string;
}) {
  const value = percent === null ? null : Math.min(100, Math.max(0, percent));
  const cls = tone === "neutral" ? "is-neutral" : LEVEL_CLASS[tone];
  return (
    <span className={`resource-meter ${cls}`} role="img" aria-label={ariaLabel}>
      <span className="resource-meter-track">
        {value !== null && value > 0 && (
          <span className="resource-meter-fill" style={{ width: `${value}%` }} />
        )}
      </span>
    </span>
  );
}

export interface StackedSlice {
  id: string;
  /** 占给定分母的百分比；null = 分母不可用（不画）。 */
  percent: number | null;
  /** 调色板序号 1–8。 */
  colorIndex?: number;
}

/**
 * 占比条：分段宽度只由调用方给定的分母决定（绝不自行换算系统容量）。
 * 分段之间的区分同时依靠图例文字，不只用颜色传达含义。
 */
export function StackedBar({
  slices,
  ariaLabel,
  emptyLabel,
}: {
  slices: StackedSlice[];
  ariaLabel: string;
  emptyLabel: string;
}) {
  const visible = slices.filter(
    (slice) => slice.percent !== null && slice.percent > 0,
  );
  if (visible.length === 0) {
    return <p className="resource-stacked-empty">{emptyLabel}</p>;
  }
  return (
    <div className="resource-stacked" role="img" aria-label={ariaLabel}>
      {visible.map((slice) => (
        <span
          key={slice.id}
          className={`resource-stacked-seg color-${((slice.colorIndex ?? 1) - 1) % 8 + 1}`}
          style={{ width: `${slice.percent}%` }}
        />
      ))}
    </div>
  );
}

/** 图例色块：与 StackedBar 使用同一调色板序号。 */
export function ChartSwatch({ colorIndex }: { colorIndex: number }) {
  return (
    <span
      className={`resource-swatch color-${((colorIndex - 1) % 8) + 1}`}
      aria-hidden="true"
    />
  );
}

/* ── 短时趋势 ─────────────────────────────────────────────── */

export interface TrendDatum {
  /** 采样时刻（毫秒），决定横轴间距。 */
  at: number;
  /** 0–100；null = 该次读取不可用，断线而不是伪造 0%。 */
  percent: number | null;
}

export interface TrendGeometry {
  /** SVG path；少于 2 个有效点或全部缺失时为 null。 */
  line: string | null;
  /** 有效点中的真实最小值/最大值（不是绘图域的留白边界）。 */
  min: number | null;
  max: number | null;
  validCount: number;
}

const TREND_WIDTH = 100;
const TREND_HEIGHT = 30;
/** 上下留白，避免线贴边被裁。 */
const TREND_PAD = 3;

/**
 * 趋势折线几何：横轴按真实采样时刻，缺失点断线。
 *
 * 纵轴在数据区间上下留一点余量（避免平线贴边），但展示的「区间」始终是
 * 真实最小/最大值；`null` 不参与取值，也绝不替换成 0。
 */
export function buildTrendGeometry(points: ReadonlyArray<TrendDatum>): TrendGeometry {
  const valid = points.filter(
    (point): point is { at: number; percent: number } =>
      point.percent !== null && Number.isFinite(point.percent),
  );
  const realMin = valid.length ? Math.min(...valid.map((point) => point.percent)) : null;
  const realMax = valid.length ? Math.max(...valid.map((point) => point.percent)) : null;
  if (valid.length < 2 || realMin === null || realMax === null) {
    return { line: null, min: realMin, max: realMax, validCount: valid.length };
  }

  const firstAt = Math.min(...points.map((point) => point.at));
  const lastAt = Math.max(...points.map((point) => point.at));
  const span = lastAt - firstAt;
  const xAt = (index: number) =>
    span > 0
      ? ((points[index].at - firstAt) / span) * TREND_WIDTH
      : (index / Math.max(1, points.length - 1)) * TREND_WIDTH;

  // 平线（或变化极小）时给纵轴 ±0.5 的窗口，让线段落在中间而不是贴边。
  let domainMin = realMin;
  let domainMax = realMax;
  if (domainMax - domainMin < 0.5) {
    const mid = (domainMax + domainMin) / 2;
    domainMin = Math.max(0, mid - 0.5);
    domainMax = Math.min(100, mid + 0.5);
  }
  const domainSpan = domainMax - domainMin;
  const yAt = (percent: number) =>
    TREND_HEIGHT - TREND_PAD - ((percent - domainMin) / domainSpan) * (TREND_HEIGHT - TREND_PAD * 2);

  let line = "";
  let open = false;
  points.forEach((point, index) => {
    if (point.percent === null || !Number.isFinite(point.percent)) {
      open = false;
      return;
    }
    const x = xAt(index).toFixed(2);
    const y = yAt(point.percent).toFixed(2);
    line += `${open ? " L" : " M"}${x} ${y}`;
    open = true;
  });

  return {
    line: line.trim() ? line.trim() : null,
    min: realMin,
    max: realMax,
    validCount: valid.length,
  };
}

export interface TrendSparklineProps {
  points: ReadonlyArray<TrendDatum>;
  level: PressureLevel;
  title: string;
  /** 当前值（含百分号）；不可读时由调用方传「暂不可用」。 */
  valueText: string;
  statusText: string;
  /** 有效点不足时的占位说明（不是错误）。 */
  emptyText: string;
  /** 真实区间文案；不足 2 个点时传 null。 */
  rangeText: string | null;
  ariaLabel: string;
}

/** 资源短时趋势折线：静态 SVG，无动画；缺失点断开，不把不可读画成 0%。 */
export function TrendSparkline({
  points,
  level,
  title,
  valueText,
  statusText,
  emptyText,
  rangeText,
  ariaLabel,
}: TrendSparklineProps) {
  const geometry = buildTrendGeometry(points);
  return (
    <figure className={`resource-trend-card ${LEVEL_CLASS[level]}`} role="img" aria-label={ariaLabel}>
      <figcaption className="resource-trend-head">
        <span className="resource-trend-title">{title}</span>
        <span className="resource-trend-value">{valueText}</span>
        <span className="resource-trend-status">{statusText}</span>
      </figcaption>
      {geometry.line ? (
        <svg
          className="resource-trend-svg"
          viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d={geometry.line}
            className="resource-trend-line"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        <div className="resource-trend-empty">{emptyText}</div>
      )}
      {rangeText && (
        <div className="resource-trend-meta">
          <span className="resource-trend-range">{rangeText}</span>
        </div>
      )}
    </figure>
  );
}
