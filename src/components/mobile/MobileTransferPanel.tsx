//! 手机互传：桌面端的独立功能页（左侧导航入口）。
//!
//! 从「设置 → 手机与同步」提出来：配对、设备与文件传输是操作，不是偏好。
//! 设置页只保留真正的配置项；这里复用既有 `MobileSyncSection`，避免两套实现。
//! 2026-11-14 统一工作台适配：page-fill 骨架 + 页面级页头 + 宽屏两栏
//! （主列=同步与传输，右列=虚拟屏与扩展能力）；MobileSyncSection 内部零改动。
import { Smartphone } from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import MobileSyncSection from "../settings/MobileSyncSection";
import VirtualDisplaySection from "./VirtualDisplaySection";
import "./mobile-page.css";

export default function MobileTransferPanel() {
  const { t } = useLocale();

  return (
    <div className="mobile-transfer-panel page-fill">
      <header className="wf-head-row mobile-page-head">
        <div>
          <h2 className="wf-title">
            <Smartphone size={16} aria-hidden="true" /> {t("mobileTransfer.title")}
          </h2>
          <p className="wf-subtitle">{t("mobileTransfer.subtitle")}</p>
        </div>
      </header>
      <div className="page-scroll mobile-body">
        <div className="mobile-body-grid">
          <section className="mobile-body-main" aria-label={t("mobileTransfer.title")}>
            <MobileSyncSection />
          </section>
          <aside className="mobile-body-side" aria-label={t("virtualDisplay.title")}>
            <VirtualDisplaySection />
          </aside>
        </div>
      </div>
    </div>
  );
}
