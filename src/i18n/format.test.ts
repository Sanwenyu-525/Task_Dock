import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatLocalizedDate,
  formatLocalizedDateTime,
  formatLocalizedNumber,
  formatLocalizedPercent,
  formatLocalizedRelative,
} from "./format";
import { __resetLocaleForTests, setLocalePreference } from "./index";

beforeEach(() => {
  __resetLocaleForTests();
});

afterEach(() => {
  __resetLocaleForTests();
});

describe("本地化日期", () => {
  it("中文日期与英文日期分别使用 Intl", () => {
    const zh = formatLocalizedDate("2026-11-03T12:00:00");
    expect(zh).toContain("2026");
    expect(zh).toContain("11");
    expect(zh).toContain("3");

    setLocalePreference("en-US");
    const en = formatLocalizedDate("2026-11-03T12:00:00");
    expect(en).toMatch(/Nov/i);
    expect(en).toContain("2026");
  });

  it("日期时间包含 24 小时制时刻", () => {
    const text = formatLocalizedDateTime("2026-11-03T18:30:00");
    expect(text).toContain("18:30");
  });

  it("无效输入返回空串", () => {
    expect(formatLocalizedDate("invalid")).toBe("");
  });
});

describe("本地化数字", () => {
  it("千分位与百分比", () => {
    expect(formatLocalizedNumber(1234567.891, { maximumFractionDigits: 2 })).toBe(
      "1,234,567.89",
    );
    expect(formatLocalizedPercent(0.42)).toBe("42%");
  });

  it("非有限数字返回空串", () => {
    expect(formatLocalizedNumber(Number.NaN)).toBe("");
    expect(formatLocalizedPercent(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("本地化相对时间", () => {
  const now = new Date("2026-11-04T10:00:00");

  it("中文使用中文单位", () => {
    expect(formatLocalizedRelative("2026-11-04T10:30:00", now)).toBe("30分钟后");
  });

  it("英文使用 Intl.RelativeTimeFormat", () => {
    setLocalePreference("en-US");
    expect(formatLocalizedRelative("2026-11-04T10:30:00", now)).toBe("in 30 minutes");
    expect(formatLocalizedRelative("2026-11-03T10:00:00", now)).toBe("1 day ago");
  });
});
