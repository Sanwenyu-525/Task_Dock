//! 主题/材质/视觉预设解析（纯函数，可测试）。
//!
//! 三个维度正交，不要互相覆盖：
//! - **视觉预设**（visualPreset）：dream-gradient | liquid-glass —— 决定设计语言
//!   （表面层级、边光、发光、圆角、阴影），是 v0.6 新增的一层。
//! - **明暗模式**（theme）：light | dark | system —— 只决定色板明暗。
//! - **材质**（material）：solid | glass —— 决定窗口是否透出桌面。
//!
//! 玻璃有两套**实际渲染通道**，不能混为一谈（v0.7 修复）：
//! - Native Glass：Mica/Acrylic/Blur 真正应用成功，背后桌面被系统模糊。
//! - CSS Glass：Win11 + 窗口区域裁剪的默认安全路径，只有 CSS 半透明/高光，
//!   没有原生模糊，必须用更高不透明度的可读性参数。
//! - Solid：不透明白底，兼容性兜底。
//!
//! `resolveMaterial` 只回答「玻璃是否生效」，`resolveGlassRender` 再回答
//! 「生效的是原生还是 CSS」。把后者当成前者（v0.7 之前 `applied` 的用法）
//! 会让 CSS 玻璃错误地声明成 Native Glass，跳过 CSS 可读性兜底。

export type MaterialSetting = "solid" | "glass";
export type ResolvedTheme = "light" | "dark";
export type VisualPreset = "dream-gradient" | "liquid-glass" | "frosted" | "clear";
/** 清透模式的前景配色：auto 跟随明暗主题，dark/light 强制深/浅色文字。 */
export type ClearForeground = "auto" | "dark" | "light";
/** 实际渲染状态：原生模糊玻璃 / 纯 CSS 玻璃 / 不透明 */
export type GlassRender = "native" | "css" | "solid";

/** 预设顺序即设置页展示顺序；第一个为缺省值。 */
export const VISUAL_PRESETS: readonly VisualPreset[] = [
  "dream-gradient",
  "liquid-glass",
  "frosted",
  "clear",
];

/**
 * 安全默认预设：设置缺失（旧库升级）、值损坏、类型错误都落到这里。
 * 与 Rust 端 `default_visual_preset()` 必须保持一致。
 */
export const DEFAULT_VISUAL_PRESET: VisualPreset = "dream-gradient";

/** 预设对应的窗口圆角（逻辑像素），同时下发给 Win32 区域裁剪。 */
export const PRESET_WINDOW_RADIUS: Record<VisualPreset, number> = {
  "dream-gradient": 18,
  "liquid-glass": 20,
  frosted: 20,
  clear: 20,
};

export const PRESET_LABELS: Record<VisualPreset, { name: string; tagline: string }> = {
  "dream-gradient": { name: "梦幻渐变", tagline: "柔和蓝紫粉 · 轻毛玻璃" },
  "liquid-glass": { name: "液态玻璃", tagline: "通透折射 · 玻璃胶囊" },
  frosted: { name: "柔光玻璃", tagline: "淡蓝白磨砂 · 精细边光" },
  clear: { name: "清透玻璃", tagline: "真实桌面透出 · 极简边缘" },
};

/** Rust `MaterialResult.effect` 中真正代表原生模糊的取值。 */
export const NATIVE_GLASS_EFFECTS: readonly string[] = ["mica", "acrylic", "blur"];

export interface SystemFlags {
  prefersDark: boolean;
  highContrast: boolean;
  reducedTransparency: boolean;
  /** 是否已有可用的玻璃渲染（CSS 或原生都算）；null = 尚未探测 */
  glassApplied: boolean | null;
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
  return setting === "liquid-glass" || setting === "frosted" || setting === "clear"
    ? setting
    : DEFAULT_VISUAL_PRESET;
}

/**
 * 独立原生窗口（右键菜单 / 通知 / 截图）的预设映射。
 *
 * 清透玻璃依赖「主窗口近乎全透明」这一整窗级别的合成策略；直接套到弹窗、
 * 通知或截图遮罩会牺牲可读性/命中区域，因此这些窗口回退到液态玻璃材质，
 * 只共享同一套前景色板。主窗口不受影响。
 */
export function resolveSecondaryPreset(preset: VisualPreset): VisualPreset {
  return preset === "clear" ? "liquid-glass" : preset;
}

export function resolveClearForeground(setting: string | null | undefined): ClearForeground {
  return setting === "dark" || setting === "light" ? setting : "auto";
}

export function presetRadius(preset: VisualPreset): number {
  return PRESET_WINDOW_RADIUS[preset] ?? PRESET_WINDOW_RADIUS[DEFAULT_VISUAL_PRESET];
}

/**
 * 玻璃是否生效：请求 glass + 系统未禁用透明 + 玻璃渲染（CSS 或原生）确实应用。
 *
 * 注意这里**不再要求原生 Mica/Acrylic**：Win11 + 区域裁剪的默认路径就是
 * CSS 玻璃，把它判成 solid 会让默认环境直接失去玻璃主题。
 */
export function resolveMaterial(setting: string, flags: SystemFlags): MaterialSetting {
  if (setting !== "glass") return "solid";
  if (flags.highContrast) return "solid";
  if (flags.reducedTransparency) return "solid";
  if (flags.glassApplied === false) return "solid";
  return "glass";
}

/** 区分「原生模糊」与「纯 CSS」——两者必须使用不同的透明度与兜底参数。 */
export function resolveGlassRender(
  resolved: MaterialSetting,
  effect: string,
  applied: boolean | null,
): GlassRender {
  if (resolved !== "glass" || applied !== true) return "solid";
  return NATIVE_GLASS_EFFECTS.includes(effect) ? "native" : "css";
}

/** 当前实际材质是否由原生 Mica/Acrylic/Blur 支撑（决定是否启用原生半透明语言）。 */
export function hasNativeGlass(resolved: MaterialSetting, render: GlassRender): boolean {
  return resolved === "glass" && render === "native";
}

/** 从 matchMedia 读取系统标志（注入便于测试）。 */
export function readSystemFlags(
  match: (q: string) => boolean,
  glassApplied: boolean | null,
): SystemFlags {
  return {
    prefersDark: match("(prefers-color-scheme: dark)"),
    highContrast: match("(prefers-contrast: more)"),
    reducedTransparency: match("(prefers-reduced-transparency: more)"),
    glassApplied,
  };
}
