import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISUAL_PRESET,
  PRESET_WINDOW_RADIUS,
  hasNativeGlass,
  presetRadius,
  readSystemFlags,
  resolveClearForeground,
  resolveGlassRender,
  resolveMaterial,
  resolveSecondaryPreset,
  resolveTheme,
  resolveVisualPreset,
} from "./theme";

const F = {
  prefersDark: false,
  highContrast: false,
  reducedTransparency: false,
  glassApplied: true,
};

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
    expect(resolveMaterial("solid", { ...F, glassApplied: true })).toBe("solid");
  });
  it("glass 默认生效（CSS 玻璃也算生效）", () => {
    expect(resolveMaterial("glass", F)).toBe("glass");
  });
  it("高对比度回退 solid", () => {
    expect(resolveMaterial("glass", { ...F, highContrast: true })).toBe("solid");
  });
  it("系统减少透明回退 solid", () => {
    expect(resolveMaterial("glass", { ...F, reducedTransparency: true })).toBe("solid");
  });
  it("玻璃渲染失败才回退 solid；未探测(null)按生效处理", () => {
    expect(resolveMaterial("glass", { ...F, glassApplied: false })).toBe("solid");
    expect(resolveMaterial("glass", { ...F, glassApplied: null })).toBe("glass");
  });
});

describe("resolveGlassRender", () => {
  it("原生效果才算 native", () => {
    for (const effect of ["mica", "acrylic", "blur"]) {
      expect(resolveGlassRender("glass", effect, true)).toBe("native");
      expect(hasNativeGlass("glass", resolveGlassRender("glass", effect, true))).toBe(true);
    }
  });

  it("CSS 玻璃不得被当成原生玻璃", () => {
    expect(resolveGlassRender("glass", "css", true)).toBe("css");
    expect(hasNativeGlass("glass", "css")).toBe(false);
  });

  it("未知/空效果名按 CSS 处理（保守，不虚报原生）", () => {
    expect(resolveGlassRender("glass", "none", true)).toBe("css");
    expect(resolveGlassRender("glass", "", true)).toBe("css");
  });

  it("未应用或已回退 solid 时都是 solid", () => {
    expect(resolveGlassRender("glass", "mica", false)).toBe("solid");
    expect(resolveGlassRender("glass", "css", null)).toBe("solid");
    expect(resolveGlassRender("solid", "mica", true)).toBe("solid");
    expect(hasNativeGlass("solid", "native")).toBe(false);
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
    expect(flags.glassApplied).toBe(false);
  });
});

describe("视觉预设解析", () => {
  it("已知值原样返回", () => {
    expect(resolveVisualPreset("dream-gradient")).toBe("dream-gradient");
    expect(resolveVisualPreset("liquid-glass")).toBe("liquid-glass");
    expect(resolveVisualPreset("frosted")).toBe("frosted");
    expect(resolveVisualPreset("clear")).toBe("clear");
  });

  it("清透只属于主窗：独立弹窗回退到液态玻璃材质", () => {
    expect(resolveSecondaryPreset("clear")).toBe("liquid-glass");
    expect(resolveSecondaryPreset("frosted")).toBe("frosted");
    expect(resolveSecondaryPreset("dream-gradient")).toBe("dream-gradient");
  });

  it("清透前景：非法值回退 auto，不把 undefined 写进 DOM", () => {
    expect(resolveClearForeground("dark")).toBe("dark");
    expect(resolveClearForeground("light")).toBe("light");
    for (const v of [undefined, null, "", "system", "DARK"]) {
      expect(resolveClearForeground(v as string | null | undefined)).toBe("auto");
    }
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
    expect(presetRadius("frosted")).toBe(20);
    expect(presetRadius("clear")).toBe(20);
    expect(PRESET_WINDOW_RADIUS["liquid-glass"]).toBeGreaterThan(PRESET_WINDOW_RADIUS["dream-gradient"]);
  });
});
