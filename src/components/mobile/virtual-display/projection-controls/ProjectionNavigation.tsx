//! 一级手机导航：返回 / Home / 最近任务。
//!
//! **图标方向保持既有实现，禁止修改**（ArrowLeft / Home / List，上轮验收已确认）。
//! 最近任务在虚拟屏不受支持时禁用并显示原因，绝不发送 IPC。

import { ArrowLeft, Home, List, Loader2 } from "lucide-react";

import { useLocale } from "../../../../hooks/useLocale";
import { useProjectionTooltip } from "./ProjectionTooltip";
import type { ProjectionCapabilities } from "./types";

interface ProjectionNavigationProps {
  capabilities: ProjectionCapabilities;
  busyAction: string | null;
  onNavigate(action: "back" | "home" | "recents"): void;
}

export function ProjectionNavigation({
  capabilities,
  busyAction,
  onNavigate,
}: ProjectionNavigationProps) {
  const { t } = useLocale();
  const tooltip = useProjectionTooltip();
  const guard = (enabled: boolean) => enabled && !busyAction;

  const report = (element: HTMLElement, content: string) => {
    const rect = element.getBoundingClientRect();
    tooltip.showTooltip(content, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  };
  const leave = () => tooltip.hideTooltip();
  const focus = (event: React.FocusEvent<HTMLButtonElement>, content: string) => {
    tooltip.cancelTooltipHide();
    report(event.currentTarget, content);
  };

  const bind = (content: string) => ({
    onMouseEnter: (event: React.MouseEvent<HTMLButtonElement>) =>
      report(event.currentTarget, content),
    onMouseLeave: leave,
    onFocus: (event: React.FocusEvent<HTMLButtonElement>) => focus(event, content),
    onBlur: leave,
  });

  const recentsTip = capabilities.recents
    ? t("projectionToolbar.recents")
    : t("projectionToolbar.recentsUnsupported");

  return (
    <>
      <button
        type="button"
        className="projection-control-button"
        aria-label={t("projectionToolbar.back")}
        disabled={!guard(capabilities.back)}
        onClick={() => onNavigate("back")}
        {...bind(t("projectionToolbar.back"))}
      >
        {busyAction === "back" ? (
          <Loader2 size={20} className="spin" aria-hidden="true" />
        ) : (
          <ArrowLeft size={20} aria-hidden="true" />
        )}
      </button>

      <button
        type="button"
        className="projection-control-button"
        aria-label={t("projectionToolbar.home")}
        disabled={!guard(capabilities.home)}
        onClick={() => onNavigate("home")}
        {...bind(t("projectionToolbar.home"))}
      >
        {busyAction === "home" ? (
          <Loader2 size={20} className="spin" aria-hidden="true" />
        ) : (
          <Home size={20} aria-hidden="true" />
        )}
      </button>

      <button
        type="button"
        className="projection-control-button"
        aria-label={recentsTip}
        disabled={!guard(capabilities.recents)}
        onClick={() => onNavigate("recents")}
        {...bind(recentsTip)}
      >
        {busyAction === "recents" ? (
          <Loader2 size={20} className="spin" aria-hidden="true" />
        ) : (
          <List size={20} aria-hidden="true" />
        )}
      </button>
    </>
  );
}
