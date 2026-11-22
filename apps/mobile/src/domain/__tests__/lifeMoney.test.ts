// 货币精度与金额/数量解析：规则事实源是 docs/life/life-contract-vectors.json，
// 桌面端 Rust 测试读取同一份向量。这里不再手写“两端大概一致”的期望值——
// 任何一端放宽/收紧（例如重新接受千分位或 `.5`）都会在共享向量上失败。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAX_AMOUNT_MINOR,
  MAX_QUANTITY_INTEGER_DIGITS,
  currencyDecimals,
  formatLifeCurrencyTotals,
  formatMoneyMinor,
  groupLifeCurrencyTotals,
  normalizeCurrency,
  normalizeLifeName,
  normalizeQuantity,
  parseMoneyMinor,
  resolveAmountScale,
} from "../life";

interface NameVector {
  input: string;
  normalized: string;
}

interface CurrencyVector {
  input: string;
  currency?: string;
  decimals?: number;
  reason?: string;
  messagePattern?: string;
}

interface ScaleVector {
  currency: string;
  requested: number | null;
  scale?: number;
  reason?: string;
  messagePattern?: string;
}

interface MoneyVector {
  input: string;
  currency: string;
  amountScale: number | null;
  minor?: number;
  reason?: string;
  messagePattern?: string;
}

interface QuantityVector {
  input: string;
  quantity?: string | null;
  reason?: string;
  messagePattern?: string;
}

interface ContractVectors {
  limits: { max_amount_minor: number; max_quantity_integer_digits: number };
  name_normalization: NameVector[];
  currency_normalization: CurrencyVector[];
  currency_decimals: CurrencyVector[];
  amount_scale: ScaleVector[];
  money: MoneyVector[];
  quantity: QuantityVector[];
}

const vectors: ContractVectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../../docs/life/life-contract-vectors.json", import.meta.url),
    ),
    "utf8",
  ),
);

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("期望抛错，实际成功返回");
}

describe("共享契约向量（与 Rust 同源）", () => {
  it("上限常量与向量一致", () => {
    expect(vectors.limits.max_amount_minor).toBe(MAX_AMOUNT_MINOR);
    expect(vectors.limits.max_quantity_integer_digits).toBe(MAX_QUANTITY_INTEGER_DIGITS);
  });

  it("名称归一化逐字一致", () => {
    for (const vector of vectors.name_normalization) {
      expect(normalizeLifeName(vector.input), vector.input).toBe(vector.normalized);
    }
  });

  it("货币规范化与精度", () => {
    for (const vector of vectors.currency_normalization) {
      if (vector.currency !== undefined) {
        expect(normalizeCurrency(vector.input), vector.input).toBe(vector.currency);
      } else {
        expect(messageOf(() => normalizeCurrency(vector.input))).toContain(
          vector.messagePattern ?? "",
        );
      }
    }
    for (const vector of vectors.currency_decimals) {
      if (vector.decimals !== undefined) {
        expect(currencyDecimals(vector.input), vector.input).toBe(vector.decimals);
      } else {
        expect(messageOf(() => currencyDecimals(vector.input))).toContain(
          vector.messagePattern ?? "",
        );
      }
    }
  });

  it("金额精度解析（含历史行沿用更细精度）", () => {
    for (const vector of vectors.amount_scale) {
      if (vector.scale !== undefined) {
        expect(
          resolveAmountScale(vector.currency, vector.requested),
          `${vector.currency} requested=${String(vector.requested)}`,
        ).toBe(vector.scale);
      } else {
        expect(
          messageOf(() => resolveAmountScale(vector.currency, vector.requested)),
        ).toContain(vector.messagePattern ?? "");
      }
    }
  });

  it("金额解析：接受与拒绝的边界完全一致", () => {
    for (const vector of vectors.money) {
      if (vector.minor !== undefined) {
        expect(
          parseMoneyMinor(vector.input, vector.currency, vector.amountScale),
          `${JSON.stringify(vector.input)} ${vector.currency}`,
        ).toBe(vector.minor);
      } else {
        expect(
          messageOf(() => parseMoneyMinor(vector.input, vector.currency, vector.amountScale)),
          `${JSON.stringify(vector.input)} ${vector.currency} (${vector.reason ?? ""})`,
        ).toContain(vector.messagePattern ?? "");
      }
    }
  });

  it("数量解析：规范文本与拒绝原因一致", () => {
    for (const vector of vectors.quantity) {
      if (vector.quantity !== undefined) {
        expect(normalizeQuantity(vector.input), vector.input).toBe(vector.quantity);
      } else if (!vector.reason) {
        expect(normalizeQuantity(vector.input)).toBeNull();
      } else {
        expect(
          messageOf(() => normalizeQuantity(vector.input)),
          `${JSON.stringify(vector.input)} (${vector.reason})`,
        ).toContain(vector.messagePattern ?? "");
      }
    }
  });
});

describe("金额边界与展示", () => {
  it("空输入表示“没记金额”，不会变成 0", () => {
    expect(parseMoneyMinor("", "CNY")).toBeNull();
    expect(parseMoneyMinor("   ", "CNY")).toBeNull();
    expect(parseMoneyMinor(null, "CNY")).toBeNull();
    expect(normalizeQuantity("")).toBeNull();
  });

  it("按行 scale 解析历史金额，避免旧 JPY 行按 0 位重算", () => {
    expect(parseMoneyMinor("100.00", "JPY", 2)).toBe(10_000);
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
