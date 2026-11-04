//! 完整面板停靠态的轻量「收缩为胶囊」入口。
//!
//! 只在 `docked-full` 相位渲染（主界面完整可见时），贴着停靠边悬浮，
//! 不占内容布局、不加设置页。图标方向指向屏幕边缘，与胶囊轨道的收起按钮
//! 保持同一套 Chevron 视觉语言；点击只写偏好，引擎在已停靠时原地切换形态。

import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, type LucideIcon } from "lucide-react";
import type { SnapEdge } from "../../lib/edgeSnap";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { t } from "../../i18n";
import { railTipPlacement } from "./CapsuleRail";

const ICONS: Record<SnapEdge, LucideIcon> = {
  left: ChevronLeft,
  right: ChevronRight,
  top: ChevronUp,
  bottom: ChevronDown,
};

export default function DockFormToggle({ edge }: { edge: SnapEdge }) {
  const formSwitch = useEdgeSnapStore((s) => s.formSwitch);
  const Icon = ICONS[edge];
  return (
    <button
      type="button"
      className="cap-form-toggle"
      data-edge={edge}
      data-tip={t("capsule.toCapsule")}
      data-tip-placement={railTipPlacement("docked", edge, true)}
      aria-label={t("capsule.toCapsule")}
      disabled={!formSwitch}
      onClick={() => formSwitch?.("capsule")}
    >
      <Icon size={15} strokeWidth={2} aria-hidden />
    </button>
  );
}
