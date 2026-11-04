//! 设置页「语言」行（自包含，便于设置面板直接挂载）。
//!
//! 接入方式见 `tmp/acceptance/i18n/integration.md`：在设置页的「外观与主题」
//! 分区内放一个 `<LanguageSetting />` 即可，无需改动语言持久化逻辑。

import Select from "../components/ui/Select";
import { useLocale } from "../hooks/useLocale";
import type { LocalePreference } from "./index";

export default function LanguageSetting() {
  const { preference, setPreference, t } = useLocale();

  const options = [
    { value: "zh-CN" as const, label: t("settings.language.zhCN") },
    { value: "en-US" as const, label: t("settings.language.enUS") },
    { value: "system" as const, label: t("settings.language.system") },
  ];

  return (
    <>
      <div className="setting-row">
        <span>{t("settings.language")}</span>
        <Select<LocalePreference>
          ariaLabel={t("settings.language")}
          size="sm"
          value={preference}
          options={options}
          onChange={(value) => setPreference(value)}
        />
      </div>
      <div className="setting-note">{t("settings.language.note")}</div>
    </>
  );
}
