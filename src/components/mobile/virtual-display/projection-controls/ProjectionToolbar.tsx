//! 投屏控制栏组合根：一级导航（返回/Home/最近任务）+ 截屏 + 更多。
//!
//! 只做 UI 与交互转发：所有动作都通过 props 回调交给 Session 层（ToolbarApp），
//! 组件本身**不直接调用 Rust**（避免工具栏绕过会话绑定）。
//! 图标方向保持既有实现（ArrowLeft/Home/List，已验收），本轮只改容器/热区/Hover/Tooltip。

import type { ReactNode } from "react";

import { useLocale } from "../../../../hooks/useLocale";
import { ProjectionNavigation } from "./ProjectionNavigation";
import { ProjectionActions } from "./ProjectionActions";
import { ProjectionTooltipLayer } from "./ProjectionTooltip";
import type { ProjectionCapabilities, ProjectionLayoutModeUi } from "./types";

export type { ProjectionCapabilities, ProjectionLayoutModeUi };

export { capabilitiesForSession, defaultProjectionCapabilities } from "./types-capabilities";

/** 会话信息子集（ToolbarApp 从 vdSession 快照裁剪传入，保持本组件无业务依赖）。 */
export interface ProjectionSessionSummary {
  mode: "mirror" | "virtual";
  status: string;
  size: string | null;
  package: string | null;
  app_label: string | null;
  display_id: number | null;
}

export interface ProjectionToolbarProps {
  sessionId: string;
  session: ProjectionSessionSummary;
  capabilities: ProjectionCapabilities;
  /** 一体化布局模式（side/bottom/compact）。 */
  layoutMode: ProjectionLayoutModeUi;
  /** 正在执行动作（导航/截图）：只禁用对应按钮，不整栏阻塞。 */
  busyAction?: string | null;
  /** 更多面板内容（会话信息/诊断/结束投屏），由 ToolbarApp 注入。 */
  moreMenu: ReactNode;
  /** 更多面板是否展开（受控，ToolbarApp 负责收起时机）。 */
  moreOpen: boolean;

  onNavigate(action: "back" | "home" | "recents"): void;
  onScreenshot(): void;
  onToggleMore(open: boolean): void;
}

export default function ProjectionToolbar({
  sessionId,
  session,
  capabilities,
  layoutMode,
  busyAction = null,
  moreMenu,
  moreOpen,
  onNavigate,
  onScreenshot,
  onToggleMore,
}: ProjectionToolbarProps) {
  const { t } = useLocale();

  return (
    <div
      className={`projection-controls mode-${layoutMode}`}
      data-session={sessionId}
      data-display={session.display_id ?? undefined}
      role="toolbar"
      aria-label={t("projectionToolbar.label")}
      aria-orientation={layoutMode === "bottom" ? "horizontal" : "vertical"}
    >
      <div className="projection-nav">
        <div className="projection-nav-bar">
          <ProjectionNavigation
            capabilities={capabilities}
            busyAction={busyAction}
            onNavigate={onNavigate}
          />
          <ProjectionActions
            capabilities={capabilities}
            busyAction={busyAction}
            moreOpen={moreOpen}
            onScreenshot={onScreenshot}
            onToggleMore={() => onToggleMore(!moreOpen)}
          />
        </div>
        {moreOpen ? moreMenu : null}
      </div>
    </div>
  );
}

export { ProjectionTooltipLayer };
