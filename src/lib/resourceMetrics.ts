//! 资源管理图表用的纯计算：使用率、压力等级、比例与格式。
//!
//! 所有页面共用同一套公式与阈值，组件不得自行重复计算：
//! - `usedPercent = (total - available) / total * 100`，结果限制在 0–100；
//! - 总量必须 > 0 且有限；未知/非法输入一律返回 `unknown`，绝不当成 0%；
//! - 可用量大于总量时按「已用 0」处理（数据异常时宁可显示 0% 也不显示负使用率）；
//! - 阈值集中在本文件：<80 正常，80–<90 关注，>=90 紧张。

/** 使用率压力等级。`unknown` 表示数据不可读，不是 0%。 */
export type PressureLevel = "normal" | "attention" | "critical" | "unknown";

/** 关注阈值（百分比，含）。 */
export const PRESSURE_ATTENTION = 80;
/** 紧张阈值（百分比，含）。 */
export const PRESSURE_CRITICAL = 90;

export interface UsageMetric {
  totalBytes: number | null;
  availableBytes: number | null;
  usedBytes: number | null;
  /** 0–100 的原始精度百分比；不可读时为 null。展示时用 `formatPercent`。 */
  usedPercent: number | null;
  level: PressureLevel;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 百分比安全限制在 0–100；非有限值返回 null（不把 NaN 当 0）。 */
export function clampPercent(value: number | null | undefined): number | null {
  if (!isFiniteNumber(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/** 百分比 → 压力等级；null / 非法值返回 `unknown`。 */
export function pressureLevel(percent: number | null | undefined): PressureLevel {
  const value = clampPercent(percent);
  if (value === null) return "unknown";
  if (value >= PRESSURE_CRITICAL) return "critical";
  if (value >= PRESSURE_ATTENTION) return "attention";
  return "normal";
}

/**
 * 由总量与可用量计算使用率。
 *
 * 非法输入（null / NaN / Infinity / 负数 / 总量 0）→ `unknown`，四个数值字段按
 * 可读性分别保留：只有能确认的字段才带值，其余为 null。
 */
export function computeUsage(
  totalBytes: number | null | undefined,
  availableBytes: number | null | undefined,
): UsageMetric {
  const total = isFiniteNumber(totalBytes) && totalBytes > 0 ? totalBytes : null;
  const available =
    isFiniteNumber(availableBytes) && availableBytes >= 0 ? availableBytes : null;
  if (total === null || available === null) {
    return {
      totalBytes: total,
      availableBytes: available,
      usedBytes: null,
      usedPercent: null,
      level: "unknown",
    };
  }
  // 可用量异常大于总量时夹紧，避免出现负使用率与超过 100% 的圆弧。
  const clampedAvailable = Math.min(available, total);
  const used = total - clampedAvailable;
  const percent = clampPercent((used / total) * 100);
  return {
    totalBytes: total,
    availableBytes: clampedAvailable,
    usedBytes: used,
    usedPercent: percent,
    level: pressureLevel(percent),
  };
}

/** 百分比展示：默认一位小数；不可读返回 null（由界面显示「暂不可用」）。 */
export function formatPercent(percent: number | null | undefined, digits = 1): string | null {
  const value = clampPercent(percent);
  if (value === null) return null;
  return `${value.toFixed(Math.max(0, Math.min(3, digits)))}%`;
}

/**
 * 部分占整体的百分比（0–100）。分母非法或 <= 0 时返回 null：
 * 不把「没有分母」显示成 0%。
 */
export function proportionPercent(
  part: number | null | undefined,
  whole: number | null | undefined,
): number | null {
  if (!isFiniteNumber(part) || part < 0) return null;
  if (!isFiniteNumber(whole) || whole <= 0) return null;
  return clampPercent((Math.min(part, whole) / whole) * 100);
}

/** 相对最大值的比例（进程内存条用）：仅表达相对长度，不是系统占比。 */
export function relativePercent(
  value: number | null | undefined,
  max: number | null | undefined,
): number | null {
  if (!isFiniteNumber(value) || value < 0) return null;
  if (!isFiniteNumber(max) || max <= 0) return null;
  return clampPercent((Math.min(value, max) / max) * 100);
}

export interface BreakdownSlice<T extends string = string> {
  id: T;
  bytes: number;
  /** 占给定分母的百分比；分母不可用时为 null。 */
  percent: number | null;
}

/**
 * 生成占比切片：分母由调用方明确给出（例如「已统计的应用数据总量」），
 * 组件不得自行用系统磁盘容量当分母。零字节项保留（图例需要显示 0），
 * 但调用方应在条形图中跳过它们。
 */
export function buildBreakdown<T extends string>(
  items: ReadonlyArray<{ id: T; bytes: number }>,
  totalBytes: number | null | undefined,
): Array<BreakdownSlice<T>> {
  return items.map((item) => ({
    id: item.id,
    bytes: isFiniteNumber(item.bytes) && item.bytes > 0 ? item.bytes : 0,
    percent: proportionPercent(item.bytes, totalBytes),
  }));
}
