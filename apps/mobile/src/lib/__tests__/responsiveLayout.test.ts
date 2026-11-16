import { describe, expect, it } from "vitest";

import { decodeRecentTitle, RECENT_TITLE_MAX_LENGTH } from "../recentTitle";
import {
  gridColumnsForWidth,
  shouldStackFileCards,
  shouldUseNarrowStats,
} from "../responsiveLayout";

describe("responsiveLayout", () => {
  it("320/340dp 工具网格为两列，常规手机为四列，断点只影响结构", () => {
    expect(gridColumnsForWidth(320)).toBe(2);
    expect(gridColumnsForWidth(340)).toBe(2);
    expect(gridColumnsForWidth(341)).toBe(4);
    expect(gridColumnsForWidth(390)).toBe(4);
  });

  it("工作区文件集合在 320dp 或 130% 字号改纵向，360dp 标准字号仍三列", () => {
    expect(shouldStackFileCards(320, 1)).toBe(true);
    expect(shouldStackFileCards(360, 1.3)).toBe(true);
    expect(shouldStackFileCards(360, 1.15)).toBe(false);
    expect(shouldStackFileCards(390, 1)).toBe(false);
  });

  it("四项统计在手机宽度 2×2，平板宽度才一行四格", () => {
    expect(shouldUseNarrowStats(320)).toBe(true);
    expect(shouldUseNarrowStats(360)).toBe(true);
    expect(shouldUseNarrowStats(430)).toBe(true);
    expect(shouldUseNarrowStats(480)).toBe(false);
  });
});

describe("decodeRecentTitle", () => {
  it("解码常见的 content URI 冒号编码", () => {
    expect(decodeRecentTitle("文件document%3A1000069262")).toBe("文件document:1000069262");
    expect(decodeRecentTitle("a%2Fb%20c")).toBe("a/b c");
  });

  it("正常标题原样返回，不重复解码", () => {
    expect(decodeRecentTitle("周会记录")).toBe("周会记录");
    expect(decodeRecentTitle("report-2026.pdf")).toBe("report-2026.pdf");
  });

  it("非法百分号转义原样保留，不抛异常", () => {
    expect(decodeRecentTitle("折扣 100%")).toBe("折扣 100%");
    expect(decodeRecentTitle("bad%ZZ")).toBe("bad%ZZ");
    expect(decodeRecentTitle("%E4%B8")).toBe("%E4%B8");
  });

  it("解码后超长标题截断到固定上限", () => {
    const long = "x".repeat(RECENT_TITLE_MAX_LENGTH + 12);
    expect(decodeRecentTitle(long)).toHaveLength(RECENT_TITLE_MAX_LENGTH);
  });

  it("空标题安全返回", () => {
    expect(decodeRecentTitle("")).toBe("");
  });
});
