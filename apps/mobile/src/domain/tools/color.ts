// 颜色纯函数：ARGB → RGB/HEX/HSL、HEX 解析、WCAG 相对亮度与对比度。
//
// 约束：
// - 输入一律按「不透明」处理（原生采样返回 ARGB，取色器只展示 RGB；alpha 单独返回）；
// - HEX 只接受 #RRGGBB / #RGB，拒绝缩写以外的格式（不猜测 #RGBA）；
// - HSL 采用 CSS 语义：H 0–360、S/L 0–100%，四舍五入到整数，便于复制到设计工具；
// - 对比度按 WCAG 2.1 相对亮度公式计算，返回 1–21 的原始比值，不在域层判断 AA/AAA。
// 本文件为纯函数：不得 import react / react-native / expo / db。

export interface RgbColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface HslColor {
  h: number;
  s: number;
  l: number;
}

/** 原生返回的 ARGB 是无符号 32 位整数；越界值返回 null，由 UI 当作「未取到颜色」。 */
export function argbToRgb(value: number): RgbColor | null {
  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) return null;
  const v = Math.trunc(value);
  return {
    a: (v >>> 24) & 0xff,
    r: (v >>> 16) & 0xff,
    g: (v >>> 8) & 0xff,
    b: v & 0xff,
  };
}

export function rgbToHex(color: Pick<RgbColor, "r" | "g" | "b">): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[color.r, color.g, color.b]
    .map((channel) => clamp(channel).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

export function parseHex(input: string): RgbColor | null {
  const text = input.trim();
  const long = /^#?([0-9a-fA-F]{6})$/.exec(text);
  if (long) {
    const value = long[1];
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
      a: 255,
    };
  }
  const short = /^#([0-9a-fA-F]{3})$/.exec(text);
  if (!short) return null;
  const chars = short[1];
  return {
    r: parseInt(chars[0] + chars[0], 16),
    g: parseInt(chars[1] + chars[1], 16),
    b: parseInt(chars[2] + chars[2], 16),
    a: 255,
  };
}

export function rgbToHsl(color: Pick<RgbColor, "r" | "g" | "b">): HslColor {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const light = (max + min) / 2;

  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
    else if (max === g) hue = ((b - r) / delta + 2) * 60;
    else hue = ((r - g) / delta + 4) * 60;
  }
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
  return {
    h: Math.round(hue) % 360,
    s: Math.round(saturation * 100),
    l: Math.round(light * 100),
  };
}

export function formatRgb(color: RgbColor): string {
  return color.a >= 255 ? `rgb(${color.r}, ${color.g}, ${color.b})` : `rgba(${color.r}, ${color.g}, ${color.b}, ${(color.a / 255).toFixed(2)})`;
}

export function formatHsl(hsl: HslColor): string {
  return `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
}

/** WCAG 2.1 相对亮度（sRGB 线性化）。 */
export function relativeLuminance(color: Pick<RgbColor, "r" | "g" | "b">): number {
  const channel = (value: number) => {
    const c = Math.max(0, Math.min(255, value)) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** 对比度 = (L亮 + 0.05) / (L暗 + 0.05)，范围 1–21；完全相同为 1。 */
export function contrastRatio(
  first: Pick<RgbColor, "r" | "g" | "b">,
  second: Pick<RgbColor, "r" | "g" | "b">,
): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}
