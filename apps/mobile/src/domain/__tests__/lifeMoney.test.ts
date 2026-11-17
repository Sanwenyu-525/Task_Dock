// 货币精度单元测试：按 ISO 小数位解析/展示，不允许所有货币统一按两位处理。
import { describe, expect, it } from "vitest";

import {
  currencyDecimals,
  formatLifeCurrencyTotals,
  formatMoneyMinor,
  groupLifeCurrencyTotals,
  parseMoneyMinor,
} from "../life";

describe("货币精度", () => {
  it("CNY/USD 2 位、JPY 0 位、KWD 3 位", () => {
    expect(currencyDecimals("CNY")).toBe(2);
    expect(currencyDecimals("USD")).toBe(2);
    expect(currencyDecimals("JPY")).toBe(0);
    expect(currencyDecimals("KWD")).toBe(3);
    expect(() => currencyDecimals("XYZ")).toThrow(/暂不支持货币/);
  });

  it("按货币精度解析最小单位整数，拒绝超出精度", () => {
    expect(parseMoneyMinor("48", "CNY")).toBe(4800);
    expect(parseMoneyMinor("48.5", "CNY")).toBe(4850);
    expect(parseMoneyMinor("48.05", "USD")).toBe(4805);
    expect(parseMoneyMinor("48", "JPY")).toBe(48);
    expect(() => parseMoneyMinor("48.5", "JPY")).toThrow(/不支持小数/);
    expect(parseMoneyMinor("48.123", "KWD")).toBe(48123);
    expect(() => parseMoneyMinor("48.1234", "KWD")).toThrow(/最多 3 位/);
    expect(() => parseMoneyMinor("48.555", "CNY")).toThrow(/最多 2 位/);
    expect(() => parseMoneyMinor("48", "")).toThrow(/必须选择货币/);
    expect(parseMoneyMinor("", "CNY")).toBeNull();
  });

  it("按行 scale 解析历史金额，避免旧 JPY 行按 0 位重算", () => {
    expect(parseMoneyMinor("100.00", "JPY", 2)).toBe(10000);
    expect(parseMoneyMinor("100", "JPY", 0)).toBe(100);
  });

  it("展示按行 scale，不丢 JPY/KWD 精度", () => {
    expect(formatMoneyMinor(4800, "CNY", 2)).toBe("¥48.00");
    expect(formatMoneyMinor(48, "JPY", 0)).toBe("JP¥48");
    expect(formatMoneyMinor(48123, "KWD", 3)).toBe("KD 48.123");
    // 缺省 scale 保持旧行为（两位），用于没有迁移信息的调用方。
    expect(formatMoneyMinor(4800, "CNY")).toBe("¥48.00");
    expect(formatMoneyMinor(null, "CNY", 2)).toBe("");
  });

  it("不同货币绝不直接相加：CNY 100.00 + USD 100.00 显示两行", () => {
    const totals = groupLifeCurrencyTotals([
      { totalPriceMinor: 10_000, currency: "CNY", amountScale: 2 },
      { totalPriceMinor: 10_000, currency: "USD", amountScale: 2 },
    ]);
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ currency: "CNY", totalPriceMinor: 10_000, amountScale: 2 });
    expect(totals[1]).toMatchObject({ currency: "USD", totalPriceMinor: 10_000, amountScale: 2 });
    expect(formatLifeCurrencyTotals(totals)).toBe("¥100.00\n$100.00");
  });

  it("JPY 0 位、KWD 3 位与历史 scale 混用仍保持精确", () => {
    const jpy = groupLifeCurrencyTotals([
      { totalPriceMinor: 100, currency: "JPY", amountScale: 0 },
      { totalPriceMinor: 500, currency: "JPY", amountScale: 2 },
    ]);
    expect(jpy[0]).toMatchObject({ totalPriceMinor: 105, amountScale: 0 });

    const legacyFraction = groupLifeCurrencyTotals([
      { totalPriceMinor: 50, currency: "JPY", amountScale: 2 },
      { totalPriceMinor: 1, currency: "JPY", amountScale: 0 },
    ]);
    expect(legacyFraction[0]).toMatchObject({ totalPriceMinor: 150, amountScale: 2 });

    const kwd = groupLifeCurrencyTotals([
      { totalPriceMinor: 100, currency: "KWD", amountScale: 2 },
      { totalPriceMinor: 1, currency: "KWD", amountScale: 3 },
    ]);
    expect(kwd[0]).toMatchObject({ totalPriceMinor: 1_001, amountScale: 3 });

    const cny = groupLifeCurrencyTotals([
      { totalPriceMinor: 10_000, currency: "CNY", amountScale: 2 },
      { totalPriceMinor: 5_000, currency: "CNY", amountScale: 3 },
    ]);
    expect(cny[0]).toMatchObject({ totalPriceMinor: 10_500, amountScale: 2 });
  });

  it("空金额不累计，未填货币单独成组且显示明确", () => {
    const totals = groupLifeCurrencyTotals([
      { totalPriceMinor: null, currency: "CNY", amountScale: 2 },
      { totalPriceMinor: 1_200, currency: "", amountScale: 2 },
      { totalPriceMinor: 300, currency: "CNY", amountScale: 2 },
    ]);
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ currency: "CNY", totalPriceMinor: 300, itemCount: 1 });
    expect(totals[1].currency).toBe("");
    expect(formatLifeCurrencyTotals(totals)).toBe("¥3.00\n未标注货币 12.00");
    expect(formatLifeCurrencyTotals([])).toBe("");
  });
});
