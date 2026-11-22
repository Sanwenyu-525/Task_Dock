import { describe, expect, it } from "vitest";

import {
  DEFAULT_COL_WIDTHS,
  MAX_COL_WIDTHS,
  MIN_COL_WIDTHS,
  MIN_NAME_WIDTH,
  GRID_CHROME,
  clampColWidth,
  effectiveColWidth,
  maxForName,
  normalizeColWidths,
} from "./columnWidths";

describe("clampColWidth", () => {
  it("落在列自身上下限内", () => {
    expect(clampColWidth("time", 150)).toBe(150);
    expect(clampColWidth("time", 10)).toBe(MIN_COL_WIDTHS.time);
    expect(clampColWidth("time", 9999)).toBe(MAX_COL_WIDTHS.time);
    expect(clampColWidth("size", 0)).toBe(MIN_COL_WIDTHS.size);
    expect(clampColWidth("type", -20)).toBe(MIN_COL_WIDTHS.type);
  });

  it("名称列保底上限压过列自身上限；上限低于下限时按下限兜底", () => {
    expect(clampColWidth("time", 260, 200)).toBe(200);
    expect(clampColWidth("size", 100, 10)).toBe(MIN_COL_WIDTHS.size);
    // NaN/Infinity 输入回下限（拖拽坐标异常时不产生非法宽度）。
    expect(clampColWidth("time", Number.NaN)).toBe(MIN_COL_WIDTHS.time);
  });
});

describe("maxForName", () => {
  it("容器宽减去图标/内边距/间距、其余固定列与名称保底", () => {
    const width = maxForName(600, {}, "time");
    expect(width).toBe(600 - GRID_CHROME - MIN_NAME_WIDTH - DEFAULT_COL_WIDTHS.size - DEFAULT_COL_WIDTHS.type);
  });

  it("计入用户已改过的其余列宽", () => {
    const width = maxForName(600, { size: 200, type: 100 }, "time");
    expect(width).toBe(600 - GRID_CHROME - MIN_NAME_WIDTH - 200 - 100);
  });
});

describe("normalizeColWidths", () => {
  it("保留合法列宽并取整", () => {
    expect(normalizeColWidths({ time: 150.4, size: 90 })).toEqual({ time: 150, size: 90 });
  });

  it("非法/越界列丢弃，该列回默认；全非法返回 undefined", () => {
    expect(normalizeColWidths({ time: 10, size: "big", type: Number.NaN })).toBeUndefined();
    expect(normalizeColWidths({ time: 9999 })).toBeUndefined();
    expect(normalizeColWidths("x")).toBeUndefined();
    expect(normalizeColWidths(null)).toBeUndefined();
    expect(normalizeColWidths([150])).toBeUndefined();
  });
});

describe("effectiveColWidth", () => {
  it("未定制的列回默认，定制列用用户值", () => {
    expect(effectiveColWidth({}, "time")).toBe(DEFAULT_COL_WIDTHS.time);
    expect(effectiveColWidth({ time: 200 }, "time")).toBe(200);
  });
});
