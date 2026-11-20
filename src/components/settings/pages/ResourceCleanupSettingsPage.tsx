//! 资源清理页（自 SettingsPanel「资源管理」分组原样迁移，2026-11-20）。
//! 完整资源管理中心是独立一级页面；设置里只保留入口，避免两份完整界面。

import { HardDrive } from "lucide-react";
import SettingsPageLayout from "../SettingsPageLayout";
import { useUiStore } from "../../../store/useUiStore";
import { useLocale } from "../../../hooks/useLocale";

export default function ResourceCleanupSettingsPage() {
  const { t } = useLocale();
  const setTab = useUiStore((s) => s.setTab);

  return (
    <SettingsPageLayout
      icon={HardDrive}
      title={t("settings.section.resourceCleanup")}
      description={t("settings.section.resourceCleanupDesc")}
      variant="diagnostic"
    >
      <div className="resource-entry">
        <div className="resource-entry-text">
          <strong>{t("settings.resourceEntry.title")}</strong>
          <span>{t("settings.resourceEntry.desc")}</span>
        </div>
        <button
          type="button"
          className="btn sm"
          onClick={() => setTab("resource")}
        >
          {t("settings.resourceEntry.open")}
        </button>
      </div>
    </SettingsPageLayout>
  );
}
