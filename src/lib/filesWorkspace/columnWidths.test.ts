import { describe, expect, it } from "vitest";

import {
  DEFAULT_COL_WIDTHS,
  GRID_CHROME,
  MAX_COL_WIDTHS,
  MIN_COL_WIDTHS,
  applyBoundaryDrag,
  effectiveColWidth,
  normalizeColWidths,
} from "./columnWidths";

describe("applyBoundaryDrag：time-size 边界", () => {
  it("光标右移：左列（日期）变宽、右列（大小）变窄，总宽恒定", () => {
    const { widths, applied } = applyBoundaryDrag(1300, {}, "time-size", 20);
    expect(applied).toBe(20);
    expect(widths).toEqual({ time: 138, size: 56 });
    expect(widths.time! + widths.size!).toBe(DEFAULT_COL_WIDTHS.time + DEFAULT_COL_WIDTHS.size);
  });

  it("光标左移：左列变窄、右列变宽", () => {
    const { widths } = applyBoundaryDrag(1300, {}, "time-size", -30);
    expect(widths).toEqual({ time: 88, size: 106 });
  });

  it("两侧列各自钳制上下限；位移停在钳制点", () => {
    // 日期列已在上限：向右拖位移为 0，返回原宽（调用方以 applied===0 免提交）。
    const atMax = { time: MAX_COL_WIDTHS.time, size: 100 };
    const { widths, applied } = applyBoundaryDrag(1300, atMax, "time-size", 50);
    expect(applied).toBe(0);
    expect(widths).toEqual({ time: MAX_COL_WIDTHS.time, size: 100 });
    // 大小列已在下限：向左拖时大小列回升、日期列变窄，位移被日期列下限钳制。
    const atMin = { size: MIN_COL_WIDTHS.size };
    const left = applyBoundaryDrag(1300, atMin, "time-size", -50);
    expect(left.applied).toBe(-(DEFAULT_COL_WIDTHS.time - MIN_COL_WIDTHS.time));
    expect(left.widths).toEqual({ time: MIN_COL_WIDTHS.time, size: MIN_COL_WIDTHS.size + 46 });
    // 大小列钳到下限时位移被截断。
    const mid = applyBoundaryDrag(1300, {}, "time-size", -100);
    expect(mid.applied).toBe(-(DEFAULT_COL_WIDTHS.size - MIN_COL_WIDTHS.size));
    expect(mid.widths).toEqual({ time: DEFAULT_COL_WIDTHS.time + 28, size: MIN_COL_WIDTHS.size });
  });

  it("位移按整数取整", () => {
    const { widths } = applyBoundaryDrag(1300, {}, "time-size", 12.6);
    expect(widths).toEqual({ time: 131, size: 63 });
  });
});

describe("applyBoundaryDrag：size-type 边界", () => {
  it("大小列变宽、类型列变窄", () => {
    const { widths } = applyBoundaryDrag(1300, {}, "size-type", 20);
    expect(widths).toEqual({ size: 96, type: 68 });
  });
});

describe("applyBoundaryDrag：name-time 边界（名称列弹性）", () => {
  it("右列（日期）随位移反向变化，名称列不落存储", () => {
    const { widths } = applyBoundaryDrag(1300, {}, "name-time", -40);
    expect(widths).toEqual({ time: DEFAULT_COL_WIDTHS.time + 40 });
    expect("name" in widths).toBe(false);
  });

  it("名称保底约束：容器富余时日期列变宽受名称保底钳制", () => {
    // 日期列自身下限 72 先钳住位移（hi = 118-72 = 46），名称保底有余量不构成约束。
    const wide = applyBoundaryDrag(1300, {}, "name-time", 800);
    expect(wide.applied).toBe(46);
    expect(wide.widths).toEqual({ time: MIN_COL_WIDTHS.time });
    // 容器紧张（名称 55 < 保底 96）：右拖被抬到把名称补回保底的位移。
    // nameNow = 400-63-282 = 55 → lo = 96-55 = 41 > delta 30 → applied = 41。
    const tight = applyBoundaryDrag(400, {}, "name-time", 30);
    expect(tight.applied).toBe(41);
    expect(tight.widths).toEqual({ time: DEFAULT_COL_WIDTHS.time - 41 });
    // 容器 0（极端）：名称保底不可能满足，位移钳到日期列自身下限。
    const zero = applyBoundaryDrag(0, {}, "name-time", 8);
    expect(zero.applied).toBe(DEFAULT_COL_WIDTHS.time - MIN_COL_WIDTHS.time);
    expect(zero.widths).toEqual({ time: MIN_COL_WIDTHS.time });
  });
});

describe("normalizeColWidths / effectiveColWidth", () => {
  it("保留合法列宽并取整", () => {
    expect(normalizeColWidths({ time: 150.4, size: 90 })).toEqual({ time: 150, size: 90 });
  });

  it("非法/越界列丢弃，全非法返回 undefined", () => {
    expect(normalizeColWidths({ time: 10, size: "big", type: Number.NaN })).toBeUndefined();
    expect(normalizeColWidths({ time: 9999 })).toBeUndefined();
    expect(normalizeColWidths("x")).toBeUndefined();
    expect(normalizeColWidths(null)).toBeUndefined();
    expect(normalizeColWidths([150])).toBeUndefined();
  });

  it("未定制列回默认，定制列用用户值", () => {
    expect(effectiveColWidth({}, "time")).toBe(DEFAULT_COL_WIDTHS.time);
    expect(effectiveColWidth({ time: 200 }, "time")).toBe(200);
  });
});

describe("常量与 files.css 对齐", () => {
  it("chrome = 内边距 16 + 图标 15 + 4×8 列距", () => {
    expect(GRID_CHROME).toBe(63);
  });
});
