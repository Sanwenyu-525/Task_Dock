//! 设置分组基元（2026-11-20 设置中心第二阶段）。
//!
//! 只表达「一条业务分组」：标题 + 说明 + 右侧动作 + 内容。
//! 不持有状态、不知道业务，也不引入新的卡片体系——页面卡片由
//! `.settings-page-body` 提供（styles-pages.css），组与组之间只用
//! 间距 + 一条细分隔线表达层级，避免「每行一张卡」或「全页只有横线」。
//!
//! 视觉规范：
//! - 组标题 = h4（页面标题是 h3），12px/650，主文字色；
//! - 组说明 = 11px，`--color-text-muted`（对比度达 AA，不用 `--text-tertiary`）；
//! - 组内设置行仍是 `.setting-row`（左名称/说明，右控件），不为每种页面造新行。

import type { ReactNode } from "react";

interface Props {
  /** 分组标题（已本地化）。 */
  title: string;
  /** 分组说明（可选，一行两句以内）。 */
  description?: string;
  /** 标题右侧动作（刷新、创建、恢复默认等）。 */
  actions?: ReactNode;
  /** 标题锚点 id（搜索定位/测试用）。 */
  id?: string;
  className?: string;
  children: ReactNode;
}

export default function SettingsGroup({
  title,
  description,
  actions,
  id,
  className,
  children,
}: Props) {
  return (
    <section className={`settings-group${className ? ` ${className}` : ""}`}>
      <header className="settings-group-head">
        <div className="settings-group-heading">
          <h4 className="settings-group-title" id={id}>
            {title}
          </h4>
          {description ? <p className="settings-group-desc">{description}</p> : null}
        </div>
        {actions ? <div className="settings-group-actions">{actions}</div> : null}
      </header>
      <div className="settings-group-body">{children}</div>
    </section>
  );
}
