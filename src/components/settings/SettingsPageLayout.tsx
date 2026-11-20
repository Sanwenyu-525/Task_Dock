//! 设置子页面统一骨架（2026-11-20 设置中心重构）。
//!
//! 只负责「子页面标题 + 描述 + 右侧动作 + 内容区模板类」，不持有业务状态。
//! 模板差异（标准/配置+预览/长列表/数据诊断）用 `variant` 修饰类表达，
//! 不为四类模板各建一个壳组件（见 docs/architecture/settings-center-layout.md §3.4）。

import { useRef, type ReactNode } from "react";
import type { IconComponent } from "../ui/AgentIcon";

export type SettingsPageVariant =
  | "standard"
  | "split"
  | "list"
  | "diagnostic";

interface Props {
  /** 页面图标：来自 `settingsSectionMeta` 所属分类或页面自身语义。 */
  icon: IconComponent;
  /** 页面标题（i18n 渲染结果）。 */
  title: string;
  /** 页面描述（可选）。 */
  description?: string;
  /** 标题行右侧动作区（分段切换/恢复默认等）。 */
  actions?: ReactNode;
  /** 布局模板；影响内容区宽度与双栏行为（CSS 修饰类）。 */
  variant?: SettingsPageVariant;
  children: ReactNode;
}

export default function SettingsPageLayout({
  icon: Icon,
  title,
  description,
  actions,
  variant = "standard",
  children,
}: Props) {
  // 页面标题可聚焦但不进 Tab 序列：外部定位（搜索/reveal）切页后由
  // SettingsPanel 把焦点移到这里；树形导航自身激活时不抢焦点。
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  return (
    <section className={`settings-page settings-page--${variant}`}>
      <header className="settings-page-head">
        <h3
          ref={headingRef}
          className="settings-page-title"
          tabIndex={-1}
        >
          <Icon size={15} strokeWidth={1.7} aria-hidden="true" />
          {title}
        </h3>
        {actions ? <div className="settings-page-actions">{actions}</div> : null}
        {description ? <p className="settings-page-desc">{description}</p> : null}
      </header>
      <div className="settings-page-body">{children}</div>
    </section>
  );
}
