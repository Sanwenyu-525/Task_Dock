/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import {
  PRESSURE_ATTENTION,
  PRESSURE_CRITICAL,
  buildBreakdown,
  clampPercent,
  computeUsage,
  formatPercent,
  pressureLevel,
  proportionPercent,
  relativePercent,
} from "./resourceMetrics";

const GB = 1024 ** 3;

describe("computeUsage 百分比", () => {
  it("0%：可用等于总量", () => {
    const metric = computeUsage(100 * GB, 100 * GB);
    expect(metric.usedBytes).toBe(0);
    expect(metric.usedPercent).toBe(0);
    expect(metric.level).toBe("normal");
  });

  it("50%", () => {
    const metric = computeUsage(100 * GB, 50 * GB);
    expect(metric.usedPercent).toBeCloseTo(50, 6);
    expect(metric.level).toBe("normal");
  });

  it("79.9% 仍是正常", () => {
    const metric = computeUsage(1000, 201);
    expect(metric.usedPercent).toBeCloseTo(79.9, 6);
    expect(metric.level).toBe("normal");
  });

  it("80% 进入关注", () => {
    const metric = computeUsage(1000, 200);
    expect(metric.usedPercent).toBeCloseTo(80, 6);
    expect(metric.level).toBe("attention");
    expect(pressureLevel(PRESSURE_ATTENTION)).toBe("attention");
  });

  it("89.9% 仍是关注", () => {
    const metric = computeUsage(1000, 101);
    expect(metric.usedPercent).toBeCloseTo(89.9, 6);
    expect(metric.level).toBe("attention");
  });

  it("90% 进入紧张", () => {
    const metric = computeUsage(1000, 100);
    expect(metric.usedPercent).toBeCloseTo(90, 6);
    expect(metric.level).toBe("critical");
    expect(pressureLevel(PRESSURE_CRITICAL)).toBe("critical");
  });

  it("100%", () => {
    const metric = computeUsage(1000, 0);
    expect(metric.usedPercent).toBe(100);
    expect(metric.level).toBe("critical");
  });
});

describe("computeUsage 非法输入", () => {
  it("总量为 0 → unknown，不是 0%", () => {
    const metric = computeUsage(0, 0);
    expect(metric.totalBytes).toBeNull();
    expect(metric.usedPercent).toBeNull();
    expect(metric.level).toBe("unknown");
  });

  it("总量为 null → unknown", () => {
    expect(computeUsage(null, 100).usedPercent).toBeNull();
    expect(computeUsage(null, null).level).toBe("unknown");
  });

  it("可用量大于总量 → 标记读数异常，不解释成 0% 正常", () => {
    const metric = computeUsage(100, 200);
    // 原始读数作为证据保留，不做静默夹紧
    expect(metric.availableBytes).toBe(200);
    expect(metric.totalBytes).toBe(100);
    expect(metric.usedBytes).toBeNull();
    expect(metric.usedPercent).toBeNull();
    expect(metric.level).toBe("unknown");
    expect(metric.anomaly).toBe("available_exceeds_total");
    // 正常数据不带异常标记
    expect(computeUsage(100, 50).anomaly).toBeNull();
  });

  it("负数与 NaN / Infinity → unknown", () => {
    expect(computeUsage(-1, 10).level).toBe("unknown");
    expect(computeUsage(100, -5).level).toBe("unknown");
    expect(computeUsage(Number.NaN, 10).level).toBe("unknown");
    expect(computeUsage(100, Number.POSITIVE_INFINITY).level).toBe("unknown");
    expect(computeUsage(Number.POSITIVE_INFINITY, 0).level).toBe("unknown");
  });

  it("极大容量保持精度", () => {
    const total = 16 * 1024 * GB;
    const metric = computeUsage(total, total / 4);
    expect(metric.usedPercent).toBeCloseTo(75, 6);
    expect(metric.level).toBe("normal");
  });

  it("很小但不为零的占比不会被当成 0", () => {
    const metric = computeUsage(ONE_TB, ONE_TB - 1024);
    expect(metric.usedPercent).toBeGreaterThan(0);
    expect(metric.usedPercent).toBeLessThan(0.001);
    // 底层数值 > 0，展示为「<0.1%」，不能写成 0.0%
    expect(formatPercent(metric.usedPercent)).toBe("<0.1%");
  });
});

const ONE_TB = 1024 * GB;

describe("百分比格式与工具", () => {
  it("clampPercent 限制 0–100，非有限值返回 null", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(Number.NaN)).toBeNull();
    expect(clampPercent(66.666)).toBeCloseTo(66.666, 6);
  });

  it("formatPercent 向零截断：展示值不跨过 80/90 阈值", () => {
    expect(formatPercent(89.34)).toBe("89.3%");
    // 四舍五入会得到 90.0%，但真实等级仍是「关注」；展示必须与等级一致
    expect(formatPercent(89.96)).toBe("89.9%");
    expect(formatPercent(79.94)).toBe("79.9%");
    expect(formatPercent(79.96)).toBe("79.9%");
    expect(formatPercent(80)).toBe("80.0%");
    expect(formatPercent(89.94)).toBe("89.9%");
    expect(formatPercent(90)).toBe("90.0%");
    expect(formatPercent(99.96)).toBe("99.9%");
    expect(formatPercent(100)).toBe("100.0%");
    // 真实 0 显示 0.0%；极小非零显示 <0.1%，未知显示 null（不是 0%）
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.04)).toBe("<0.1%");
    expect(formatPercent(Number.NaN)).toBeNull();
    expect(formatPercent(null)).toBeNull();
  });

  it("每个展示值与真实等级都不冲突（含阈值边界）", () => {
    const samples = [
      0, 0.001, 0.04, 0.05, 33.333, 50, 79.9, 79.94, 79.96, 79.99, 80, 80.04,
      89.9, 89.94, 89.96, 89.99, 90, 90.04, 99.96, 100,
    ];
    for (const value of samples) {
      const shown = formatPercent(value);
      expect(shown).not.toBeNull();
      const shownValue = Number.parseFloat(shown!.replace("<", ""));
      if (shown!.startsWith("<")) continue;
      expect(pressureLevel(shownValue)).toBe(pressureLevel(value));
    }
  });

  it("proportionPercent 分母非法返回 null", () => {
    expect(proportionPercent(10, 100)).toBeCloseTo(10, 6);
    expect(proportionPercent(10, 0)).toBeNull();
    expect(proportionPercent(10, null)).toBeNull();
    expect(proportionPercent(200, 100)).toBe(100);
    expect(proportionPercent(-1, 100)).toBeNull();
  });

  it("relativePercent 只表达相对最大值的长度", () => {
    expect(relativePercent(50, 200)).toBe(25);
    expect(relativePercent(200, 200)).toBe(100);
    expect(relativePercent(50, 0)).toBeNull();
    expect(relativePercent(null, 100)).toBeNull();
  });

  it("buildBreakdown 使用调用方给定的分母", () => {
    const slices = buildBreakdown(
      [
        { id: "a", bytes: 30 },
        { id: "b", bytes: 70 },
        { id: "c", bytes: 0 },
      ],
      100,
    );
    expect(slices.map((slice) => slice.percent)).toEqual([30, 70, 0]);
    // 分母不可用时是 null，不是 0
    expect(buildBreakdown([{ id: "a", bytes: 30 }], null)[0].percent).toBeNull();
    expect(buildBreakdown([{ id: "a", bytes: 30 }], 0)[0].percent).toBeNull();
  });
});
