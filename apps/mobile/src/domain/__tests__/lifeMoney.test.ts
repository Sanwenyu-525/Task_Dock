// 货币精度单元测试：按 ISO 小数位解析/展示，不允许所有货币统一按两位处理。
import { describe, expect, it } from "vitest";

import { currencyDecimals, formatMoneyMinor, parseMoneyMinor } from "../life";

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
});
