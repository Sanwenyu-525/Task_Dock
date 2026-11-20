//! 通知设置页（自 SettingsPanel「通知」分组原样迁移，2026-11-20）。

import { Bell } from "lucide-react";
import { NumberInput, Switch } from "../../ui";
import SettingsPageLayout from "../SettingsPageLayout";
import { useSettingsStore } from "../../../store/useSettingsStore";
import { useLocale } from "../../../hooks/useLocale";

export default function NotificationSettingsPage() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  if (!settings) return null;

  return (
    <SettingsPageLayout
      icon={Bell}
      title={t("settings.section.notifications")}
      description={t("settings.section.notificationsDesc")}
    >
      <div className="setting-row">
        <span>{t("settings.notifications.reminder")}</span>
        <Switch
          checked={settings.notify_reminder}
          ariaLabel={t("settings.notifications.reminder")}
          onChange={(v) => update({ notify_reminder: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.notifications.agent")}</span>
        <Switch
          checked={settings.notify_agent}
          ariaLabel={t("settings.notifications.agent")}
          onChange={(v) => update({ notify_agent: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.notifications.muted")}</span>
        <Switch
          checked={settings.notify_muted}
          ariaLabel={t("settings.notifications.muted")}
          onChange={(v) => update({ notify_muted: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.notifications.aggregate")}</span>
        <Switch
          checked={settings.notify_done_aggregate}
          ariaLabel={t("settings.notifications.aggregate")}
          onChange={(v) => update({ notify_done_aggregate: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.notifications.rateWindow")}</span>
        <div className="btn-row">
          <NumberInput
            size="sm"
            min={10}
            max={3600}
            value={settings.notify_rate_window_secs}
            ariaLabel={t("settings.notifications.rateWindowAria")}
            onChange={(v) => update({ notify_rate_window_secs: v })}
          />
          <NumberInput
            size="sm"
            min={1}
            max={20}
            value={settings.notify_burst_max}
            ariaLabel={t("settings.notifications.burstAria")}
            onChange={(v) => update({ notify_burst_max: v })}
          />
        </div>
      </div>
      <div className="setting-note">{t("settings.notifications.note")}</div>
      <div className="setting-row">
        <span>{t("settings.notifications.overdueGrace")}</span>
        <NumberInput
          value={settings.overdue_grace_hours}
          min={1}
          max={168}
          ariaLabel={t("settings.notifications.overdueGrace")}
          onChange={(v) => update({ overdue_grace_hours: v })}
        />
      </div>
    </SettingsPageLayout>
  );
}
