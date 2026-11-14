//! 手机互传：桌面端的独立功能页（左侧导航入口）。
//!
//! 从「设置 → 手机与同步」提出来：配对、设备与文件传输是操作，不是偏好。
//! 设置页只保留真正的配置项；这里复用既有 `MobileSyncSection`，避免两套实现。
import { Smartphone } from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import MobileSyncSection from "../settings/MobileSyncSection";
import { CollapsibleSection } from "../ui";
import VirtualDisplaySection from "./VirtualDisplaySection";

export default function MobileTransferPanel() {
  const { t } = useLocale();

  return (
    <div className="mobile-transfer-panel">
      <CollapsibleSection
        id="mobile-transfer"
        className="settings-collapsible"
        icon={<Smartphone size={13} />}
        title={t("mobileTransfer.title")}
        description={t("mobileTransfer.subtitle")}
        defaultExpanded
      >
        <MobileSyncSection />
      </CollapsibleSection>
      <VirtualDisplaySection />
    </div>
  );
}
