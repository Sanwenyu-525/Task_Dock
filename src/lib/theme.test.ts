import { describe, expect, it } from "vitest";
import { readSystemFlags, resolveMaterial, resolveTheme } from "./theme";

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
