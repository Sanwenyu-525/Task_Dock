// 颜色纯函数的回归测试：重点守住通道顺序、HEX 解析与 WCAG 公式。
import { describe, expect, it } from "vitest";

import {
  argbToRgb,
  contrastRatio,
  formatHsl,
  formatRgb,
  parseHex,
  relativeLuminance,
  rgbToHex,
  rgbToHsl,
} from "../color";

describe("ARGB → RGB", () => {
  it("按 0xAARRGGBB 解出通道", () => {
    expect(argbToRgb(0xff112233)).toEqual({ a: 255, r: 17, g: 34, b: 51 });
    expect(argbToRgb(0x80112233)).toEqual({ a: 128, r: 17, g: 34, b: 51 });
  });

  it("越界与非法值返回 null", () => {
    expect(argbToRgb(-1)).toBeNull();
    expect(argbToRgb(0x100000000)).toBeNull();
    expect(argbToRgb(Number.NaN)).toBeNull();
  });
});

describe("HEX 解析与格式化", () => {
  it("接受 #RRGGBB 与 #RGB，大小写不敏感", () => {
    expect(parseHex("#FF0000")).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseHex("00ff00")).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(parseHex("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 255 });
  });

  it("拒绝 #RGBA 与非法字符", () => {
    expect(parseHex("#ffff")).toBeNull();
    expect(parseHex("#gg0000")).toBeNull();
    expect(parseHex("red")).toBeNull();
  });

  it("输出统一大写 6 位", () => {
    expect(rgbToHex({ r: 1, g: 2, b: 3 })).toBe("#010203");
    expect(rgbToHex({ r: 300, g: -1, b: 128 })).toBe("#FF0080");
  });
});

describe("HSL", () => {
  it("纯色与灰阶", () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 });
    expect(rgbToHsl({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 100, l: 50 });
    expect(rgbToHsl({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 100, l: 50 });
    expect(rgbToHsl({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, l: 50 });
  });

  it("格式化字符串可被设计工具识别", () => {
    expect(formatHsl({ h: 210, s: 40, l: 50 })).toBe("hsl(210, 40%, 50%)");
  });
});

describe("WCAG 对比度", () => {
  it("黑白对比度为 21", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 5);
  });

  it("相同颜色为 1", () => {
    expect(contrastRatio({ r: 18, g: 52, b: 86 }, { r: 18, g: 52, b: 86 })).toBeCloseTo(1, 5);
  });

  it("相对亮度与顺序无关", () => {
    const a = relativeLuminance({ r: 255, g: 0, b: 0 });
    const b = relativeLuminance({ r: 0, g: 0, b: 255 });
    expect(contrastRatio({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 })).toBeCloseTo(
      contrastRatio({ r: 0, g: 0, b: 255 }, { r: 255, g: 0, b: 0 }),
      10,
    );
    expect(a).toBeGreaterThan(b);
  });

  it("RGB 文本格式保留 alpha", () => {
    expect(formatRgb({ r: 1, g: 2, b: 3, a: 255 })).toBe("rgb(1, 2, 3)");
    expect(formatRgb({ r: 1, g: 2, b: 3, a: 128 })).toBe("rgba(1, 2, 3, 0.50)");
  });
});
