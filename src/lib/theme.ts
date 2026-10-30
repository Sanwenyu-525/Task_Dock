//! 主题/材质/视觉预设解析（纯函数，可测试）。
//!
//! 三个维度正交，不要互相覆盖：
//! - **视觉预设**（visualPreset）：dream-gradient | liquid-glass —— 决定设计语言
//!   （表面层级、边光、发光、圆角、阴影），是 v0.6 新增的一层。
//! - **明暗模式**（theme）：light | dark | system —— 只决定色板明暗。
//! - **材质**（material）：solid | glass —— 决定窗口是否透出桌面（原生 Mica/Acrylic）。
//!
//! glass 生效条件：设置允许 + 系统未开启「高对比度」+ 未「减少透明效果」
//! + 原生 Mica/Acrylic 真正应用成功。任一条件不满足即回退 solid，保证可读性；
//! 回退只影响「是否透出桌面」，不影响视觉预设本身的语言（仍有渐变与边光）。

export type MaterialSetting = "solid" | "glass";
export type ResolvedTheme = "light" | "dark";
export type VisualPreset = "dream-gradient" | "liquid-glass";

/** 预设顺序即设置页展示顺序；第一个为缺省值。 */
export const VISUAL_PRESETS: readonly VisualPreset[] = ["dream-gradient", "liquid-glass"];

/**
 * 安全默认预设：设置缺失（旧库升级）、值损坏、类型错误都落到这里。
 * 与 Rust 端 `default_visual_preset()` 必须保持一致。
 */
export const DEFAULT_VISUAL_PRESET: VisualPreset = "dream-gradient";

/** 预设对应的窗口圆角（逻辑像素），同时下发给 Win32 区域裁剪。 */
export const PRESET_WINDOW_RADIUS: Record<VisualPreset, number> = {
  "dream-gradient": 18,
  "liquid-glass": 20,
};

export const PRESET_LABELS: Record<VisualPreset, { name: string; tagline: string }> = {
  "dream-gradient": { name: "梦幻渐变", tagline: "柔和蓝紫粉 · 轻毛玻璃" },
  "liquid-glass": { name: "液态玻璃", tagline: "通透折射 · 玻璃胶囊" },
};

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

/**
 * 预设解析：未知/缺失一律回退默认。
 * 旧数据库没有 visual_preset 键时前端拿到 undefined，这里必须给出安全值，
 * 不能把 `undefined` 直接写进 data-preset（会导致所有预设样式失效）。
 */
export function resolveVisualPreset(setting: string | null | undefined): VisualPreset {
  return setting === "liquid-glass" ? "liquid-glass" : DEFAULT_VISUAL_PRESET;
}

export function presetRadius(preset: VisualPreset): number {
  return PRESET_WINDOW_RADIUS[preset] ?? PRESET_WINDOW_RADIUS[DEFAULT_VISUAL_PRESET];
}

export function resolveMaterial(setting: string, flags: SystemFlags): MaterialSetting {
  if (setting !== "glass") return "solid";
  if (flags.highContrast) return "solid";
  if (flags.reducedTransparency) return "solid";
  if (flags.nativeApplied === false) return "solid";
  return "glass";
}

/** 当前实际材质是否由原生 Mica/Acrylic 支撑（CSS 半透明只为它服务时才叠加）。 */
export function hasNativeGlass(resolved: MaterialSetting, nativeApplied: boolean | null): boolean {
  return resolved === "glass" && nativeApplied === true;
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
