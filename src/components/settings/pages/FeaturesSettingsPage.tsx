//! 功能管理页（自 SettingsPanel「功能管理」分组原样迁移，2026-11-20）。

import { Layers } from "lucide-react";
import { Select, Switch } from "../../ui";
import SettingsPageLayout from "../SettingsPageLayout";
import { useSettingsStore } from "../../../store/useSettingsStore";
import { useLocale } from "../../../hooks/useLocale";

export default function FeaturesSettingsPage() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  if (!settings) return null;

  return (
    <SettingsPageLayout
      icon={Layers}
      title={t("settings.section.features")}
      description={t("settings.section.featuresDesc")}
    >
      <div className="setting-row">
        <span>{t("settings.features.workspace")}</span>
        <Switch
          checked={settings.workspace_enabled}
          ariaLabel={t("settings.features.workspace")}
          onChange={(v) => update({ workspace_enabled: v })}
        />
      </div>
      <div className="setting-note">{t("settings.features.workspaceNote")}</div>
      <div className="setting-row">
        <span>{t("settings.features.actions")}</span>
        <Switch
          checked={settings.actions_enabled}
          ariaLabel={t("settings.features.actions")}
          onChange={(v) => update({ actions_enabled: v })}
        />
      </div>
      <div className="setting-note">{t("settings.features.actionsNote")}</div>
      <div className="setting-row">
        <span>{t("settings.features.lifeCurrency")}</span>
        <Select
          ariaLabel={t("settings.features.lifeCurrency")}
          size="sm"
          triggerClassName="settings-select-trigger"
          align="end"
          value={settings.life_default_currency}
          options={[
            { value: "", label: t("settings.features.lifeCurrency.unset") },
            { value: "CNY", label: "CNY 人民币" },
            { value: "USD", label: "USD 美元" },
            { value: "EUR", label: "EUR 欧元" },
            { value: "JPY", label: "JPY 日元" },
            { value: "GBP", label: "GBP 英镑" },
            { value: "HKD", label: "HKD 港币" },
          ]}
          onChange={(v) => update({ life_default_currency: v })}
        />
      </div>
      <div className="setting-note">{t("settings.features.lifeCurrencyNote")}</div>
      <div className="setting-note">{t("settings.features.clipboardNote")}</div>
    </SettingsPageLayout>
  );
}
