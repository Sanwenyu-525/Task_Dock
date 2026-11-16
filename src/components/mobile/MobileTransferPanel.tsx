//! 手机互传：桌面端的独立功能页（左侧导航入口）。
//!
//! 从「设置 → 手机与同步」提出来：配对、设备与文件传输是操作，不是偏好。
//! 设置页只保留真正的配置项；这里复用既有 `MobileSyncSection`，避免两套实现。
//! 2026-11-16 R5：主区改为设备/传输/详情三栏，虚拟屏作为下方扩展能力；
//! MobileSyncSection 内部的数据与暂存架逻辑保持不变，只把信息重新分区。
import { Smartphone } from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import MobileSyncSection from "../settings/MobileSyncSection";
import VirtualDisplaySection from "./VirtualDisplaySection";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import "./mobile-page.css";

export default function MobileTransferPanel() {
  const { t } = useLocale();

  return (
    <div className="mobile-transfer-panel page-fill">
      <WorkbenchPageHeader
        icon={Smartphone}
        title={t("mobileTransfer.title")}
        subtitle={t("mobileTransfer.subtitle")}
      />
      <div className="page-scroll mobile-body">
        <MobileSyncSection />
        <section className="mobile-body-tools" aria-label={t("virtualDisplay.title")}>
          <VirtualDisplaySection />
        </section>
      </div>
    </div>
  );
}
