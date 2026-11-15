//! 统一大型工作台的页面级页头（2026-11-15）。
//!
//! 结构对齐 19 张效果图：左侧图标块 + 标题/副标题，右侧动作区。
//! 只做展示，不持有业务状态；动作由各页面以 children/actions 传入，
//! 避免每个 Tab 另建一套页头与图标尺寸。

import type { ReactNode } from "react";
import type { IconComponent } from "../components/ui/AgentIcon";

interface Props {
  icon: IconComponent;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 标题右侧的补充信息（计数、状态 chip 等）。 */
  meta?: ReactNode;
  /** 右侧动作区（按钮、分段控件、刷新等）。 */
  actions?: ReactNode;
}

export default function WorkbenchPageHeader({ icon: Icon, title, subtitle, meta, actions }: Props) {
  return (
    <header className="wb-page-header">
      <span className="wb-ph-icon" aria-hidden="true">
        <Icon size={19} strokeWidth={1.7} />
      </span>
      <div className="wb-ph-main">
        <div className="wb-ph-heading">
          <h2 className="wb-ph-title">
            <span>{title}</span>
          </h2>
          {meta ? <div className="wb-ph-meta">{meta}</div> : null}
        </div>
        {subtitle ? <p className="wb-ph-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="wb-ph-actions">{actions}</div> : null}
    </header>
  );
}
