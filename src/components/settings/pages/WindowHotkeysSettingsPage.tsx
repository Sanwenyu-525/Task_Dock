//! 窗口与快捷键页（自 SettingsPanel「窗口与快捷键」分组原样迁移，2026-11-20）。

import { useState } from "react";
import { AppWindow } from "lucide-react";
import { Select, Switch } from "../../ui";
import SettingsPageLayout from "../SettingsPageLayout";
import HotkeysSection from "../hotkeys/HotkeysSection";
import { setAutostart, setHotkeysEnabled } from "../../../lib/bridge";
import { useSettingsStore } from "../../../store/useSettingsStore";
import { useLocale } from "../../../hooks/useLocale";

export default function WindowHotkeysSettingsPage() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  // 原分组行为保留：切换期间禁用开关，避免并发 setAutostart 交错。
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (!settings) return null;

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusyKey(key);
    try {
      await fn();
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <SettingsPageLayout
      icon={AppWindow}
      title={t("settings.section.windowHotkeys")}
      description={t("settings.section.windowHotkeysDesc")}
    >
      <div className="setting-row">
        <span>{t("settings.window.snap")}</span>
        <Switch
          checked={settings.snap_enabled}
          ariaLabel={t("settings.window.snap")}
          onChange={(v) => useSettingsStore.getState().update({ snap_enabled: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.window.snapMode")}</span>
        <Select
          ariaLabel={t("settings.window.snapMode")}
          size="sm"
          triggerClassName="settings-select-trigger"
          align="end"
          disabled={!settings.snap_enabled}
          value={settings.snap_display_mode === "full" ? "full" : "capsule"}
          options={[
            { value: "capsule", label: t("settings.window.snapMode.capsule") },
            { value: "full", label: t("settings.window.snapMode.full") },
          ]}
          onChange={(v) => useSettingsStore.getState().update({ snap_display_mode: v as "capsule" | "full" })}
        />
      </div>
      <div className="setting-note">{t("settings.window.snapNote")}</div>
      <div className="setting-row">
        <span>{t("settings.window.closeBehavior")}</span>
        <Select
          ariaLabel={t("settings.window.closeBehavior")}
          size="sm"
          triggerClassName="settings-select-trigger"
          align="end"
          value={settings.window_close_behavior === "quit_app" ? "quit_app" : "close_window"}
          options={[
            {
              value: "close_window",
              label: t("settings.window.closeBehavior.closeWindow"),
            },
            {
              value: "quit_app",
              label: t("settings.window.closeBehavior.quitApp"),
            },
          ]}
          onChange={(v) =>
            useSettingsStore.getState().update({
              window_close_behavior: v as "close_window" | "quit_app",
            })
          }
        />
      </div>
      <div className="setting-note">{t("settings.window.closeBehaviorNote")}</div>
      <div className="setting-row">
        <span>{t("settings.window.autostart")}</span>
        <Switch
          checked={settings.autostart}
          disabled={busyKey === "autostart"}
          ariaLabel={t("settings.window.autostart")}
          onChange={(v) =>
            void withBusy("autostart", async () => {
              await setAutostart(v);
              await useSettingsStore.getState().load();
            })
          }
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.window.hotkeySwitch")}</span>
        <Switch
          checked={settings.hotkey_enabled}
          disabled={busyKey === "hotkey"}
          ariaLabel={t("settings.window.hotkeySwitch")}
          onChange={(v) =>
            void withBusy("hotkey", async () => {
              await setHotkeysEnabled(v);
              await useSettingsStore.getState().load();
            })
          }
        />
      </div>
      <HotkeysSection />
    </SettingsPageLayout>
  );
}
