//! 主题/材质/视觉预设解析（纯函数，可测试）。
//!
//! 三个维度正交，不要互相覆盖：
//! - **视觉预设**（visualPreset）：frosted | dream-gradient —— 决定设计语言
//!   （表面层级、边光、发光、圆角、阴影）。2026-11 收口为两套；
//!   历史值 `liquid-glass` / `clear` 在读、写两侧都归一为 `frosted`。
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
export type VisualPreset = "frosted" | "dream-gradient";
/** 实际渲染状态：原生模糊玻璃 / 纯 CSS 玻璃 / 不透明 */
export type GlassRender = "native" | "css" | "solid";

/** 预设顺序即设置页展示顺序；第一个为缺省值。 */
export const VISUAL_PRESETS: readonly VisualPreset[] = ["frosted", "dream-gradient"];

/**
 * 安全默认预设：设置缺失（旧库升级）、值损坏、类型错误、历史值都落到这里。
 * 与 Rust 端 `default_visual_preset()` / `normalized_visual_preset()` 必须保持一致。
 */
export const DEFAULT_VISUAL_PRESET: VisualPreset = "frosted";

/** 预设对应的窗口圆角（逻辑像素），同时下发给 Win32 区域裁剪。 */
export const PRESET_WINDOW_RADIUS: Record<VisualPreset, number> = {
  frosted: 20,
  "dream-gradient": 18,
};

export const PRESET_LABELS: Record<VisualPreset, { name: string; tagline: string }> = {
  frosted: { name: "柔光玻璃", tagline: "淡蓝白磨砂 · 精细边光" },
  "dream-gradient": { name: "梦幻渐变", tagline: "柔和蓝紫粉 · 轻毛玻璃" },
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
 * 历史值 `liquid-glass` / `clear` 已下线，映射到默认 `frosted`（只读兜底，
 * 数据库回写由 Rust v29 迁移负责）。
 */
export function resolveVisualPreset(setting: string | null | undefined): VisualPreset {
  if (setting === "dream-gradient") return "dream-gradient";
  if (setting === "frosted") return "frosted";
  if (setting === "liquid-glass" || setting === "clear") return "frosted";
  return DEFAULT_VISUAL_PRESET;
}

/**
 * 独立原生窗口（右键菜单 / 通知 / 截图）的预设映射。
 *
 * 两套预设收口后，弹窗与主窗共用同一预设，无需再为「清透」做降级；
 * 保留该函数以维持既有调用方契约。
 */
export function resolveSecondaryPreset(preset: VisualPreset): VisualPreset {
  return preset;
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
