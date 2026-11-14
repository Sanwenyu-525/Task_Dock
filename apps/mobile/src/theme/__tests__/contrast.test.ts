// 颜色对比度契约：Token 值可以调整，但「谁可以承载文字」不能靠肉眼判断。
// 这里按 WCAG 2.1 计算真实对比度，正文/标签 ≥ 4.5:1，大字号与图标 ≥ 3:1，
// 并且浅色与深色各自独立计算——深色不是浅色的反转。
import { describe, expect, it } from "vitest";

import { palette, type Palette } from "../tokens";

type RGB = { r: number; g: number; b: number };

function parseColor(value: string): RGB & { a: number } {
  const hex = value.trim();
  if (hex.startsWith("#")) {
    const body = hex.slice(1);
    const full =
      body.length === 3
        ? body
            .split("")
            .map((c) => c + c)
            .join("")
        : body;
    const n = Number.parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const match = hex.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`无法解析颜色：${value}`);
  const [r, g, b, a] = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
  return { r, g, b, a: a ?? 1 };
}

/** 把带透明度的颜色按 alpha 合成到不透明底色上 */
function composite(foreground: string, background: string): RGB {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

function luminance(color: RGB): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** bg 必须是实色；fg 允许 rgba，会先合成到底色上 */
function contrast(fg: string | RGB, bg: string | RGB): number {
  const base = typeof bg === "string" ? parseColor(bg) : { ...bg, a: 1 };
  if (base.a < 1) throw new Error("背景必须是实色");
  const foreground = typeof fg === "string" ? composite(fg, toCss(base)) : fg;
  const [a, b] = [luminance(foreground), luminance(base)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

function toCss(color: RGB): string {
  return `rgb(${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)})`;
}

/** 半透明 soft 底必须叠到实色表面上再算，否则比值是假的 */
function over(fg: string, base: string): RGB {
  return composite(fg, base);
}

/** 所有「文字可能落在上面」的实色表面 */
function surfaces(tokens: Palette): string[] {
  return [tokens.bg, tokens.bgAccent, tokens.card, tokens.cardDone, tokens.sheet];
}

const MIN_TEXT = 4.5;
const MIN_LARGE = 3;

describe.each(["light", "dark"] as const)("%s 主题对比度", (scheme) => {
  const tokens = palette(scheme);

  it("正文四级文本在全部实色表面上达到 4.5:1", () => {
    for (const bg of surfaces(tokens)) {
      for (const key of ["text", "textSoft", "muted"] as const) {
        const ratio = contrast(tokens[key], bg);
        expect(ratio, `${key} on ${bg}`).toBeGreaterThanOrEqual(MIN_TEXT);
      }
    }
  });

  it("功能蓝文字在页面底、卡片、浅蓝水洗底与 accentSoft 上达到 4.5:1", () => {
    const backgrounds = [
      tokens.card,
      tokens.bg,
      over(tokens.accentWash, tokens.card),
      over(tokens.accentSoft, tokens.card),
      over(tokens.track, tokens.card),
    ];
    for (const bg of backgrounds) {
      const ratio = contrast(tokens.accentText, bg);
      expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT);
    }
  });

  it("品牌蓝只承载图标/装饰，对底色至少 3:1", () => {
    for (const bg of [tokens.card, tokens.bg]) {
      expect(contrast(tokens.accent, bg), `accent on ${bg}`).toBeGreaterThanOrEqual(MIN_LARGE);
    }
  });

  it("填充色上的文字达到 4.5:1", () => {
    expect(contrast(tokens.onAccent, tokens.accentFill)).toBeGreaterThanOrEqual(MIN_TEXT);
    expect(contrast(tokens.onDanger, tokens.dangerFill)).toBeGreaterThanOrEqual(MIN_TEXT);
    expect(contrast(tokens.onOk, tokens.ok)).toBeGreaterThanOrEqual(MIN_TEXT);
    expect(contrast(tokens.text, tokens.card)).toBeGreaterThanOrEqual(MIN_TEXT);
  });

  it("语义色文字在自身 soft 底与卡片上达到 4.5:1", () => {
    const pairs: [string, string, string][] = [
      ["ok", tokens.ok, tokens.okSoft],
      ["warn", tokens.warn, tokens.warnSoft],
      ["danger", tokens.danger, tokens.dangerSoft],
    ];
    for (const [key, fg, soft] of pairs) {
      expect(contrast(fg, tokens.card), `${key} on card`).toBeGreaterThanOrEqual(MIN_TEXT);
      expect(contrast(fg, over(soft, tokens.card)), `${key} on soft`).toBeGreaterThanOrEqual(
        MIN_TEXT,
      );
    }
  });

  it("弱文本只用于装饰，对卡片至少 3:1", () => {
    expect(contrast(tokens.faint, tokens.card)).toBeGreaterThanOrEqual(MIN_LARGE);
  });

  it("TabBar 选中态（accentText on accentSoft）可读", () => {
    expect(contrast(tokens.accentText, over(tokens.accentSoft, tokens.card))).toBeGreaterThanOrEqual(
      MIN_TEXT,
    );
  });
});

describe("浅色主题的实测比值（防止回归时静默变淡）", () => {
  const tokens = palette("light");

  it("关键组合保持在文档记录的区间", () => {
    expect(contrast(tokens.muted, tokens.card)).toBeGreaterThan(4.6);
    expect(contrast(tokens.accentText, tokens.card)).toBeGreaterThan(5);
    expect(contrast(tokens.onAccent, tokens.accentFill)).toBeGreaterThan(5);
    expect(contrast(tokens.warn, tokens.card)).toBeGreaterThan(5);
    expect(contrast(tokens.ok, tokens.card)).toBeGreaterThan(4.9);
    expect(contrast(tokens.danger, tokens.card)).toBeGreaterThan(5);
  });
});
