//! 二级操作区：截屏（原「更多」面板里的重复项，提升为一级）与「更多」。
//!
//! 更多按钮的价值边界见 projection-actions.ts：只有次级功能 ≥2 才显示。

import { Camera, Loader2, MoreHorizontal } from "lucide-react";

import { useLocale } from "../../../../hooks/useLocale";
import { useProjectionTooltip } from "./ProjectionTooltip";
import { shouldShowMoreButton } from "./projection-actions";
import type { ProjectionCapabilities } from "./types";

interface ProjectionActionsProps {
  capabilities: ProjectionCapabilities;
  busyAction: string | null;
  moreOpen: boolean;
  onScreenshot(): void;
  onToggleMore(): void;
}

function useTooltipBinding() {
  const tooltip = useProjectionTooltip();
  return (content: string) => ({
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      tooltip.showTooltip(content, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    },
    onMouseLeave: () => tooltip.hideTooltip(),
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      tooltip.cancelTooltipHide();
      const rect = event.currentTarget.getBoundingClientRect();
      tooltip.showTooltip(content, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    },
    onBlur: () => tooltip.hideTooltip(),
  });
}

export function ProjectionActions({
  capabilities,
  busyAction,
  moreOpen,
  onScreenshot,
  onToggleMore,
}: ProjectionActionsProps) {
  const { t } = useLocale();
  const bind = useTooltipBinding();
  const guard = (enabled: boolean) => enabled && !busyAction;

  return (
    <>
      <span className="projection-control-sep" aria-hidden="true" />

      <button
        type="button"
        className="projection-control-button"
        aria-label={t("projectionToolbar.screenshot")}
        disabled={!guard(capabilities.screenshot)}
        onClick={onScreenshot}
        {...bind(t("projectionToolbar.screenshot"))}
      >
        {busyAction === "screenshot" ? (
          <Loader2 size={20} className="spin" aria-hidden="true" />
        ) : (
          <Camera size={20} aria-hidden="true" />
        )}
      </button>

      {shouldShowMoreButton(capabilities) ? (
        <button
          type="button"
          className={`projection-control-button${moreOpen ? " is-active" : ""}`}
          aria-label={t("projectionToolbar.more")}
          aria-expanded={moreOpen}
          onClick={onToggleMore}
          {...bind(t("projectionToolbar.more"))}
        >
          <MoreHorizontal size={20} aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}
