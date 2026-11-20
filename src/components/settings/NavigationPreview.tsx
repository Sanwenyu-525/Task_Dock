//! 导航实时预览（2026-11-20 设置中心重构）。
//!
//! 职责边界（docs/architecture/settings-center-layout.md §3.4）：
//! - 读取 `useNavigationLayout()` 的**有效布局**（已提交配置 + 未落库排序草稿），
//!   拖拽/长按/显隐操作在预览里即时反映——预览反映真实草稿状态，不是静态示意图；
//! - 元数据（图标/名称/排序语义）全部来自 `navigationRegistry`，不复制注册表；
//! - 只读：不写数据库、不触发页面跳转；
//! - 完整面板与停靠胶囊共用同一份元数据，仅外观表达不同（纵向栏 vs 横向胶囊）。
//! - 对读屏用户隐藏（aria-hidden）：同一信息已由可排序管理列表完整提供，
//!   预览是视觉镜像，避免双份可访问名称造成困惑。

import {
  entriesForSurface,
  navLabel,
  type NavSurface,
} from "../../lib/navigationRegistry";
import { useNavigationLayout } from "../../lib/navigationLayout";
import { useLocale } from "../../hooks/useLocale";

export default function NavigationPreview({ surface }: { surface: NavSurface }) {
  const { t } = useLocale();
  // 有效布局 = 已提交 + 乐观意图（排序草稿可见，与左侧列表同帧更新）。
  const layout = useNavigationLayout();
  const surfaceEntries = entriesForSurface(surface);
  const visibleEntries = layout[surface]
    .map((id) => surfaceEntries.find((entry) => entry.id === id))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  return (
    <div className="nav-preview" data-surface={surface} aria-hidden="true">
      <div className="nav-preview-frame">
        {surface === "left" ? (
          <div className="nav-preview-rail">
            {visibleEntries.map((entry) => (
              <div
                key={entry.id}
                className={`nav-preview-rail-item${entry.locked ? " is-locked" : ""}`}
                title={navLabel(entry, t)}
              >
                <entry.icon size={14} strokeWidth={1.6} aria-hidden="true" />
                <span className="nav-preview-rail-label">{navLabel(entry, t)}</span>
              </div>
            ))}
            {visibleEntries.length === 0 && (
              <div className="nav-preview-empty">{t("nav.previewEmpty")}</div>
            )}
          </div>
        ) : (
          <div className="nav-preview-capsule">
            {visibleEntries.map((entry) => (
              <span
                key={entry.id}
                className={`nav-preview-capsule-item${entry.locked ? " is-locked" : ""}`}
                title={navLabel(entry, t)}
              >
                <entry.icon size={13} strokeWidth={1.6} aria-hidden="true" />
              </span>
            ))}
            {visibleEntries.length === 0 && (
              <span className="nav-preview-empty">{t("nav.previewEmpty")}</span>
            )}
          </div>
        )}
      </div>
      <div className="nav-preview-caption">
        {surface === "left" ? t("nav.surface.left") : t("nav.surface.capsule")}
        {" · "}
        {t("settings.preview.caption", { count: visibleEntries.length })}
      </div>
    </div>
  );
}
