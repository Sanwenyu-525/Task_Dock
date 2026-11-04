//! 轻量词典核心：键查找、兜底、插值、复数与缺失检测。
//!
//! 选型说明见 `docs/i18n/README.md`：本项目文案量小、无服务端下发需求，
//! 自建约 200 行运行时比引入 i18next + react-i18next（约 40KB+）更轻，
//! 且通过 `MessageKey = keyof typeof zhCN` 获得编译期键校验。

import { zhCN, type MessageKey } from "../locales/zh-CN";
import { enUS } from "../locales/en-US";

export type LocaleCode = "zh-CN" | "en-US";
/** 用户偏好：显式语言或跟随系统。 */
export type LocalePreference = LocaleCode | "system";
export type MessageParams = Record<string, string | number | undefined>;

export type { MessageKey };

export const DEFAULT_LOCALE: LocaleCode = "zh-CN";
export const SUPPORTED_LOCALES: readonly LocaleCode[] = ["zh-CN", "en-US"];

const CATALOGS: Record<LocaleCode, Record<MessageKey, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

/** 运行时缺失键集合（开发期告警、测试断言、集成期盘点）。 */
const missingKeys = new Set<string>();
const warnedKeys = new Set<string>();

function isDev(): boolean {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

function reportMissing(locale: LocaleCode, key: string): void {
  missingKeys.add(key);
  if (isDev() && !warnedKeys.has(key)) {
    warnedKeys.add(key);
    console.warn(`[i18n] missing key "${key}" in ${locale}; fell back to ${DEFAULT_LOCALE}`);
  }
}

/** 测试与诊断用：已观测到的缺失键。 */
export function getMissingKeys(): string[] {
  return [...missingKeys].sort();
}

export function resetMissingKeys(): void {
  missingKeys.clear();
  warnedKeys.clear();
}

export function isLocaleCode(value: unknown): value is LocaleCode {
  return value === "zh-CN" || value === "en-US";
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || isLocaleCode(value);
}

/** 跟随系统：zh* → zh-CN，en* → en-US，其余回归默认中文。 */
export function resolveSystemLocale(language: string | null | undefined): LocaleCode {
  if (!language) return DEFAULT_LOCALE;
  const normalized = language.toLowerCase();
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("en")) return "en-US";
  return DEFAULT_LOCALE;
}

export function resolveLocale(preference: LocalePreference, language?: string | null): LocaleCode {
  if (preference === "system") return resolveSystemLocale(language);
  return isLocaleCode(preference) ? preference : DEFAULT_LOCALE;
}

function pluralCategory(locale: LocaleCode, count: number): Intl.LDMLPluralRule | null {
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    return null;
  }
}

function lookup(locale: LocaleCode, key: MessageKey, params?: MessageParams): string | undefined {
  const catalog = CATALOGS[locale];
  if (typeof params?.count === "number" && Number.isFinite(params.count)) {
    const category = pluralCategory(locale, params.count);
    if (category) {
      const variant = catalog[`${key}_${category}` as MessageKey];
      if (variant) return variant;
      const other = catalog[`${key}_other` as MessageKey];
      if (other) return other;
    }
  }
  return catalog[key];
}

function interpolate(message: string, params?: MessageParams): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    // 参数缺失时保留占位符，便于在界面与测试中直接暴露问题，而不是悄悄吞掉。
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * 按语言查文案。缺失时回退到简体中文，再回退到键名本身。
 * `count` 参数会触发复数变体（`键_one` / `键_other`）。
 */
export function translate(locale: LocaleCode, key: MessageKey, params?: MessageParams): string {
  // 防御运行时传入非法键（例如后端返回了前端未登记的错误码）：
  // 不能让 undefined 穿透成 React 空文本或 `undefined` 字符串。
  if (typeof key !== "string" || key.length === 0) return "";
  const primary = lookup(locale, key, params);
  if (primary !== undefined) return interpolate(primary, params);
  if (locale !== DEFAULT_LOCALE) reportMissing(locale, key);
  const fallback = lookup(DEFAULT_LOCALE, key, params);
  if (fallback !== undefined) return interpolate(fallback, params);
  return key;
}
