//! 主题/材质解析（纯函数，可测试）。
//!
//! - 配色（light/dark/system）与材质（solid/glass）正交，可任意组合。
//! - glass 生效条件：设置允许 + 系统未开启「高对比度」+ 未「减少透明效果」
//!   + 原生 Mica/Acrylic 真正应用成功。
//! - 任一条件不满足即回退 solid，保证可读性。

export type MaterialSetting = "solid" | "glass";
export type ResolvedTheme = "light" | "dark";

export interface SystemFlags {
  prefersDark: boolean;
  highContrast: boolean;
  reducedTransparency: boolean;
  /** 原生 Mica/Acrylic 是否真正应用成功（null = 尚未探测） */
  nativeApplied: boolean | null;
}

export function resolveTheme(setting: string, flags: Pick<SystemFlags, "prefersDark">): ResolvedTheme {
  if (setting === "light" || setting === "dark") return setting;
  return flags.prefersDark ? "dark" : "light";
}

export function resolveMaterial(setting: string, flags: SystemFlags): MaterialSetting {
  if (setting !== "glass") return "solid";
  if (flags.highContrast) return "solid";
  if (flags.reducedTransparency) return "solid";
  if (flags.nativeApplied === false) return "solid";
  return "glass";
}

/** 从 matchMedia 读取系统标志（注入便于测试）。 */
export function readSystemFlags(
  match: (q: string) => boolean,
  nativeApplied: boolean | null,
): SystemFlags {
  return {
    prefersDark: match("(prefers-color-scheme: dark)"),
    highContrast: match("(prefers-contrast: more)"),
    reducedTransparency: match("(prefers-reduced-transparency: more)"),
    nativeApplied,
  };
}
