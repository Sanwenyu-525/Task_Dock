//! 开发者选项页（自 SettingsPanel「开发者选项」分组原样迁移，2026-11-20）。

import { FlaskConical } from "lucide-react";
import { Switch } from "../../ui";
import SettingsPageLayout from "../SettingsPageLayout";
import MockControls from "../../agents/MockControls";
import { useSettingsStore } from "../../../store/useSettingsStore";
import { useLocale } from "../../../hooks/useLocale";

export default function DeveloperSettingsPage() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  if (!settings) return null;

  return (
    <SettingsPageLayout
      icon={FlaskConical}
      title={t("settings.section.developer")}
      description={t("settings.section.developerDesc")}
      variant="diagnostic"
    >
      <div className="setting-row">
        <span>{t("settings.developer.mock")}</span>
        <Switch
          checked={settings.mock_enabled}
          ariaLabel={t("settings.developer.mock")}
          onChange={(v) => update({ mock_enabled: v })}
        />
      </div>
      <div className="setting-note">{t("settings.developer.note")}</div>
      <MockControls />
    </SettingsPageLayout>
  );
}
