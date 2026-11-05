//! 语言状态与持久化（对外统一入口）。
//!
//! - 偏好写入 localStorage（`taskdock.locale`），无需重启即可生效、重启后保留；
//! - 未配置、值非法或存储不可用时一律回落到默认简体中文；
//! - 语言偏好与后端设置解耦：数据库 schema / 设置键未改动，旧版本数据天然兼容；
//! - `document.documentElement.lang` 同步语言，供读屏、CSS 与验收脚本读取。

import { create } from "zustand";
import {
  DEFAULT_LOCALE,
  isLocalePreference,
  resolveLocale,
  translate,
  type LocaleCode,
  type LocalePreference,
  type MessageKey,
  type MessageParams,
} from "./messages";
import {
  LOCALE_STORAGE_KEY,
  initUserPreferences,
  onLocalePreferenceApplied,
  schedulePreferencesMirror,
} from "../lib/userPreferences";

// 存储键统一由 userPreferences 模块定义（语言与微件布局共用一份镜像逻辑）。
export { LOCALE_STORAGE_KEY };

interface LocaleState {
  preference: LocalePreference;
  locale: LocaleCode;
  setPreference: (preference: LocalePreference) => void;
  syncSystem: () => void;
  /** 其他窗口写入 `taskdock.locale` 后同步本窗口内存态（不回写存储，避免事件回环）。 */
  syncFromStorage: (raw: string | null) => void;
}

function systemLanguage(): string | null {
  try {
    return typeof navigator !== "undefined" ? navigator.language : null;
  } catch {
    return null;
  }
}

/** 读取偏好。损坏值、旧格式、隐私模式抛错都视为「未配置」→ 默认中文。 */
export function readStoredPreference(): LocalePreference {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_LOCALE;
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocalePreference(raw) ? raw : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function persistPreference(preference: LocalePreference): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(LOCALE_STORAGE_KEY, preference);
  } catch {
    // 存储不可用（隐私模式 / 配额满）时只保留内存态，不影响本次会话切换。
  }
  // 防抖镜像到数据目录 preferences.json，供备份/恢复使用（非 Tauri 环境自动跳过）。
  schedulePreferencesMirror();
}

function applyDocumentLocale(locale: LocaleCode): void {
  try {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale;
    document.documentElement.dataset.locale = locale;
  } catch {
    // document 不可用（测试环境）时忽略。
  }
}

const initialPreference = readStoredPreference();
const initialLocale = resolveLocale(initialPreference, systemLanguage());

export const useLocaleStore = create<LocaleState>((set, get) => {
  const applyPreference = (preference: LocalePreference) => {
    const locale = resolveLocale(preference, systemLanguage());
    set({ preference, locale });
    applyDocumentLocale(locale);
  };

  return {
    preference: initialPreference,
    locale: initialLocale,
    setPreference: (preference) => {
      // 调用方可能来自旧配置/手写存储，非法值统一收敛到默认中文。
      const next = isLocalePreference(preference) ? preference : DEFAULT_LOCALE;
      persistPreference(next);
      applyPreference(next);
    },
    syncSystem: () => {
      if (get().preference !== "system") return;
      const locale = resolveLocale("system", systemLanguage());
      if (locale !== get().locale) {
        set({ locale });
        applyDocumentLocale(locale);
      }
    },
    syncFromStorage: (raw) => {
      // 损坏值 / 其他窗口清空存储时同样收敛到默认中文，与启动读取保持一致。
      const next = isLocalePreference(raw) ? raw : DEFAULT_LOCALE;
      applyPreference(next);
    },
  };
});

applyDocumentLocale(initialLocale);

// 后端恢复/文件补齐把语言写入 localStorage 后，仅同步本窗口内存态；
// 不经过 setPreference，避免再次写存储形成镜像回环。
onLocalePreferenceApplied((preference) => {
  useLocaleStore.getState().syncFromStorage(preference);
});

/** 当前生效语言（非 React 环境也可用，如格式化工具）。 */
export function getLocale(): LocaleCode {
  return useLocaleStore.getState().locale;
}

export function getLocalePreference(): LocalePreference {
  return useLocaleStore.getState().preference;
}

export function setLocalePreference(preference: LocalePreference): void {
  useLocaleStore.getState().setPreference(preference);
}

/** 绑定当前语言的翻译函数；每次调用读取最新语言，适合事件回调与工具函数。 */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(useLocaleStore.getState().locale, key, params);
}

export interface InitLocaleOptions {
  /**
   * 是否执行偏好镜像对账（`initUserPreferences`）。
   * 桌面微件窗口按需创建、数量可变，跳过可避免每个窗口重复发起同一组存储 IPC；
   * 主题/语言仍由 `theme-changed`、`storage` 等事件与设置快照同步。
   */
  preferences?: boolean;
}

/**
 * 在主窗口与各独立 WebView 入口调用一次：同步 `<html lang>`，监听系统语言变化
 * （仅在偏好为「跟随系统」时实际切换），并监听其他窗口写入的 `taskdock.locale`
 * （设置页只在主窗口，但捕获/通知/右键菜单窗口常驻不重建，必须靠 storage 事件同步）。
 * 返回解绑函数，便于测试与热重载。
 */
export function initLocale(options: InitLocaleOptions = {}): () => void {
  applyDocumentLocale(useLocaleStore.getState().locale);
  if (typeof window === "undefined") return () => {};
  // 偏好镜像对账 + 恢复事件监听（非 Tauri 环境自动跳过）。
  const disposePreferences =
    options.preferences === false ? () => {} : initUserPreferences();
  const onLanguageChange = () => useLocaleStore.getState().syncSystem();
  const onStorage = (event: StorageEvent) => {
    // `localStorage.clear()` 触发的 key 为 null，同样按「未配置」回退默认语言。
    if (event.key !== null && event.key !== LOCALE_STORAGE_KEY) return;
    useLocaleStore.getState().syncFromStorage(event.newValue);
  };
  window.addEventListener("languagechange", onLanguageChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("languagechange", onLanguageChange);
    window.removeEventListener("storage", onStorage);
    disposePreferences();
  };
}

/** 仅供测试：恢复默认语言并清空缺失键记录。 */
export function __resetLocaleForTests(): void {
  useLocaleStore.getState().setPreference(DEFAULT_LOCALE);
  try {
    localStorage?.removeItem(LOCALE_STORAGE_KEY);
  } catch {
    // 忽略
  }
}

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  getMissingKeys,
  resetMissingKeys,
  resolveSystemLocale,
  translate,
} from "./messages";
export type { LocaleCode, LocalePreference, MessageKey, MessageParams } from "./messages";
