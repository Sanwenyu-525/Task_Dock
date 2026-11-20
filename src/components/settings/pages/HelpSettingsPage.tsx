//! 帮助与教程页（自 SettingsPanel「帮助」分组原样迁移，2026-11-20）。

import { LifeBuoy } from "lucide-react";
import SettingsPageLayout from "../SettingsPageLayout";
import ReopenOnboardingButton from "../../onboarding/ReopenOnboardingButton";
import { useSettingsStore } from "../../../store/useSettingsStore";
import { useUiStore } from "../../../store/useUiStore";
import { useLocale } from "../../../hooks/useLocale";

export default function HelpSettingsPage() {
  const { t } = useLocale();
  const setTab = useUiStore((s) => s.setTab);
  const setHelpReturnTab = useUiStore((s) => s.setHelpReturnTab);
  // 页面骨架需要 settings 就绪；与其它页面保持同一守卫口径。
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return null;

  return (
    <SettingsPageLayout
      icon={LifeBuoy}
      title={t("settings.section.help")}
      description={t("settings.section.helpDesc")}
    >
      <div className="setting-row">
        <span>{t("settings.help.center")}</span>
        <button
          type="button"
          className="btn sm"
          onClick={() => setTab("help", { after: () => setHelpReturnTab("settings") })}
        >
          {t("settings.help.open")}
        </button>
      </div>
      <div className="setting-row">
        <span>{t("settings.help.onboarding")}</span>
        <ReopenOnboardingButton />
      </div>
    </SettingsPageLayout>
  );
}
