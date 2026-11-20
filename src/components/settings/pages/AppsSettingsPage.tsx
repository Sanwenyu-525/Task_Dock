//! 应用管理页（自 SettingsPanel「应用与快捷方式」分组原样迁移，2026-11-20）。
//! 添加应用入口由 SettingsPanel 注入（onRequestAdd → AppPicker 子页面）。

import { Navigation } from "lucide-react";
import SettingsPageLayout from "../SettingsPageLayout";
import AppManagement from "../AppManagement";
import { useLocale } from "../../../hooks/useLocale";

export default function AppsSettingsPage({
  onRequestAdd,
}: {
  onRequestAdd: () => void;
}) {
  const { t } = useLocale();

  return (
    <SettingsPageLayout
      icon={Navigation}
      title={t("settings.section.apps")}
      description={t("settings.section.appsDesc")}
      variant="list"
    >
      <AppManagement onRequestAdd={onRequestAdd} />
    </SettingsPageLayout>
  );
}
