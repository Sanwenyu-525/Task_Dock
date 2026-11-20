//! 诊断与日志页（原「诊断与日志」分组内容直出，2026-11-20）。

import { ScrollText } from "lucide-react";
import SettingsPageLayout from "../SettingsPageLayout";
import DiagnosticsLogsSection from "../DiagnosticsLogsSection";
import { useLocale } from "../../../hooks/useLocale";

export default function DiagnosticsLogsSettingsPage() {
  const { t } = useLocale();
  return (
    <SettingsPageLayout
      icon={ScrollText}
      title={t("settings.section.diagnosticsLogs")}
      description={t("settings.section.diagnosticsLogsDesc")}
      variant="diagnostic"
    >
      <DiagnosticsLogsSection />
    </SettingsPageLayout>
  );
}
