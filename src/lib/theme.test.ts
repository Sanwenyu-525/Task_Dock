import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISUAL_PRESET,
  PRESET_WINDOW_RADIUS,
  hasNativeGlass,
  presetRadius,
  readSystemFlags,
  resolveMaterial,
  resolveTheme,
  resolveVisualPreset,
} from "./theme";

const F = { prefersDark: false, highContrast: false, reducedTransparency: false, nativeApplied: true };

describe("resolveTheme", () => {
  it("显式浅色/深色直接生效", () => {
    expect(resolveTheme("light", { prefersDark: true })).toBe("light");
    expect(resolveTheme("dark", { prefersDark: false })).toBe("dark");
  });
  it("跟随系统", () => {
    expect(resolveTheme("system", { prefersDark: true })).toBe("dark");
    expect(resolveTheme("system", { prefersDark: false })).toBe("light");
  });
});

describe("resolveMaterial", () => {
  it("solid 设置恒为 solid", () => {
    expect(resolveMaterial("solid", { ...F, nativeApplied: true })).toBe("solid");
  });
  it("glass 默认生效", () => {
    expect(resolveMaterial("glass", F)).toBe("glass");
  });
  it("高对比度回退 solid", () => {
    expect(resolveMaterial("glass", { ...F, highContrast: true })).toBe("solid");
  });
  it("系统减少透明回退 solid", () => {
    expect(resolveMaterial("glass", { ...F, reducedTransparency: true })).toBe("solid");
  });
  it("原生效果未应用回退 solid", () => {
    expect(resolveMaterial("glass", { ...F, nativeApplied: false })).toBe("solid");
    expect(resolveMaterial("glass", { ...F, nativeApplied: null })).toBe("glass");
  });
});

describe("readSystemFlags", () => {
  it("从 matchMedia 读取", () => {
    const flags = readSystemFlags(
      (q) => q === "(prefers-color-scheme: dark)",
      false,
    );
    expect(flags.prefersDark).toBe(true);
    expect(flags.highContrast).toBe(false);
    expect(flags.nativeApplied).toBe(false);
  });
});

describe("视觉预设解析", () => {
  it("已知值原样返回", () => {
    expect(resolveVisualPreset("dream-gradient")).toBe("dream-gradient");
    expect(resolveVisualPreset("liquid-glass")).toBe("liquid-glass");
  });

  it("旧库缺失键 / 空值 / 未知值都回退默认，不会把 undefined 写进 DOM", () => {
    for (const v of [undefined, null, "", "neon", "DREAM-GRADIENT", "0"]) {
      expect(resolveVisualPreset(v as string | null | undefined)).toBe(DEFAULT_VISUAL_PRESET);
    }
    expect(DEFAULT_VISUAL_PRESET).toBe("dream-gradient");
  });

  it("圆角半径与预设一一对应，且与 Rust 端下发值一致", () => {
    expect(presetRadius("dream-gradient")).toBe(18);
    expect(presetRadius("liquid-glass")).toBe(20);
    expect(PRESET_WINDOW_RADIUS["liquid-glass"]).toBeGreaterThan(PRESET_WINDOW_RADIUS["dream-gradient"]);
  });
});

describe("hasNativeGlass", () => {
  it("只有实际生效的 glass 才叠加原生半透明语言", () => {
    expect(hasNativeGlass("glass", true)).toBe(true);
    expect(hasNativeGlass("glass", false)).toBe(false);
    expect(hasNativeGlass("glass", null)).toBe(false);
    expect(hasNativeGlass("solid", true)).toBe(false);
  });
});
