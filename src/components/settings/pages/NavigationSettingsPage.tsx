//! 导航自定义页（2026-11-20 设置中心重构的核心页面）。
//!
//! 原「导航自定义」折叠分组升级为独立页面：
//! - `NavigationVisibilitySection` 的显隐/排序/拖拽/回滚/串行写入逻辑**全部保留**，
//!   页面只提供更大的操作空间与预览；
//! - 宽容器（≥1100px）：管理列表 + `NavigationPreview` 双栏（配置+预览模板）；
//! - 中等容器：只显示管理列表，预览可通过页头「预览」按钮展开为整宽区块；
//! - 窄容器：单列，预览跟随「预览」按钮；
//! - 预览镜像当前界面（surface 事务切换成功后经 onSurfaceSettled 同步），
//!   事实源仍在 NavigationVisibilitySection 内部。

import { useState } from "react";
import { Compass, Eye, EyeOff } from "lucide-react";
import SettingsPageLayout from "../SettingsPageLayout";
import NavigationVisibilitySection from "../NavigationVisibilitySection";
import NavigationPreview from "../NavigationPreview";
import type { NavSurface } from "../../../lib/navigationRegistry";
import { useLocale } from "../../../hooks/useLocale";

export default function NavigationSettingsPage() {
  const { t } = useLocale();
  // 预览镜像的当前界面：初始完整面板；事务切换成功后由列表组件回传。
  const [previewSurface, setPreviewSurface] = useState<NavSurface>("left");
  // 中/窄容器的预览开关（宽容器常显，按钮此时由 CSS 隐藏）。
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <SettingsPageLayout
      icon={Compass}
      title={t("settings.section.navigation")}
      description={t("settings.section.navigationDesc")}
      variant="split"
      actions={
        <button
          type="button"
          className="btn sm settings-preview-toggle"
          aria-pressed={previewOpen}
          onClick={() => setPreviewOpen((v) => !v)}
        >
          {previewOpen ? <EyeOff size={11} /> : <Eye size={11} />}{" "}
          {previewOpen ? t("settings.preview.hide") : t("settings.preview.show")}
        </button>
      }
    >
      <div className={`settings-page-split${previewOpen ? " is-preview-open" : ""}`}>
        <div className="nav-visibility-host">
          <NavigationVisibilitySection onSurfaceSettled={setPreviewSurface} />
        </div>
        <aside className="settings-page-aside">
          <NavigationPreview surface={previewSurface} />
        </aside>
      </div>
    </SettingsPageLayout>
  );
}
