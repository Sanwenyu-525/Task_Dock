//! React 语言订阅。组件把 `t` 与语言状态放在同一 hook 里，切换语言后即重新渲染。

import { useCallback } from "react";
import {
  useLocaleStore,
  translate,
  type LocaleCode,
  type LocalePreference,
  type MessageKey,
  type MessageParams,
} from "../i18n";

export interface UseLocaleResult {
  locale: LocaleCode;
  preference: LocalePreference;
  setPreference: (preference: LocalePreference) => void;
  t: (key: MessageKey, params?: MessageParams) => string;
}

export function useLocale(): UseLocaleResult {
  const locale = useLocaleStore((s) => s.locale);
  const preference = useLocaleStore((s) => s.preference);
  const setPreference = useLocaleStore((s) => s.setPreference);
  const t = useCallback(
    (key: MessageKey, params?: MessageParams) => translate(locale, key, params),
    [locale],
  );
  return { locale, preference, setPreference, t };
}
