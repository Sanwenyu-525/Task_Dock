//! 分类胶囊的左侧（或顶/底）轨道：Agent 总状态 + 四个分类入口 + 收起按钮。
//!
//! 只渲染，不做决策：状态来自 `railStatus()`（真实 store 聚合），
//! 相位来自 `useEdgeSnapStore`，当前分类来自 `useCapsuleStore`。
//!
//! 交互约定：
//! - 点击分类 = 展开该分类面板；再次点击当前分类 = 收起（由 CapsuleDock 处理）；
//! - 轨道空白处可拖动窗口（`data-tauri-drag-region`），按钮区域不触发拖动；
//! - 使用 `data-tip` 提供悬停提示（文案就是图标名，复用全局 `TooltipLayer`）；
//!   但胶囊是 Win32 区域裁剪窗口（`SetWindowRgn`），气泡必须落在可见区域内：
//!   展开态指向**屏幕内侧（面板侧）**，四个停靠边做镜像（见 `railTipPlacement`）；
//!   折叠态只有翼片可画，退回沿轨道朝中心的方向。
//! - 无障碍信息仍以 `aria-label` 为准（它比提示文案更完整，例如带待办数）。

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clipboard,
  LayoutGrid,
  ListTodo,
} from "lucide-react";
import AgentIcon, { type IconComponent } from "../ui/AgentIcon";
import CapsuleWing from "./CapsuleWing";
import { RAIL_CATEGORIES, type RailCategory, type RailStatus } from "../../lib/capsuleModel";
import { CAPSULE_GAP_CSS, RAIL_THICKNESS_CSS } from "../../lib/capsuleLayout";
import type { SnapEdge } from "../../lib/edgeSnap";

const ICONS: Record<RailCategory, IconComponent> = {
  tasks: ListTodo,
  agents: AgentIcon,
  clipboard: Clipboard,
  apps: LayoutGrid,
};

export const CATEGORY_LABELS: Record<RailCategory, string> = {
  tasks: "任务",
  agents: "Agent",
  clipboard: "剪贴板",
  apps: "应用",
};

const TONE_TEXT: Record<RailStatus["agentTone"], string> = {
  idle: "Agent 空闲",
  running: "Agent 运行中",
  waiting: "Agent 等待确认",
  failed: "Agent 执行失败",
  disconnected: "Agent 连接中断",
};

/** 展开态气泡一律朝**屏幕内侧（面板侧）**弹出，四个停靠边做镜像：
 *  左停靠 → right · 右停靠 → left · 上停靠 → bottom · 下停靠 → top。
 *
 *  为什么必须朝内而不是「沿轨道向上/向下」：胶囊窗口由 Win32 `SetWindowRgn`
 *  裁剪，气泡画在区域外不会被绘制。展开态可见区域 = 翼片 ∪ 面板，只有内侧有
 *  空间；折叠态可见区域只剩 56px 厚的翼片，内侧没有像素，此时退回沿轨道朝中心
 *  （垂直停靠向上、水平停靠向左），否则气泡会被区域裁成边缘碎片。
 *  `lead` 只影响折叠态：端头状态球贴着翼片肩部收窄段，朝上会越过可见轮廓。
 */
type TipPlacement = "top" | "left" | "bottom" | "right";
const INWARD: Record<SnapEdge, TipPlacement> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};

export function railTipPlacement(edge: SnapEdge, expanded: boolean, lead = false): TipPlacement {
  if (expanded) return INWARD[edge];
  const vertical = edge === "left" || edge === "right";
  if (vertical) return lead ? "bottom" : "top";
  return lead ? "right" : "left";
}

/** 分类项图标按钮边长（与 `.cap-btn` 一致）。 */
const CAP_ITEM_CSS = 36;
/** 展开态气泡外扩距离：越过翼片侧边余量 `(56-36)/2` + 轨道/面板 gap 8 + 区域
 *  AA 内收 2，让气泡起点落在**面板可见矩形**内，而不是落在「不属于区域、
 *  也不拦截鼠标」的间隙上（落进间隙会被裁出一条缺边）。 */
export const CAPSULE_TIP_INWARD_OFFSET =
  (RAIL_THICKNESS_CSS - CAP_ITEM_CSS) / 2 + CAPSULE_GAP_CSS + 2;

export default function CapsuleRail({
  edge,
  status,
  active,
  expanded,
  onSelect,
  onCollapse,
}: {
  edge: SnapEdge;
  status: RailStatus;
  /** 当前分类恒有值（折叠态也保留），高亮与否由 `expanded` 决定 */
  active: RailCategory;
  expanded: boolean;
  onSelect: (c: RailCategory) => void;
  onCollapse: () => void;
}) {
  const vertical = edge === "left" || edge === "right";
  const CollapseIcon =
    edge === "left" ? ChevronLeft : edge === "right" ? ChevronRight : edge === "top" ? ChevronUp : ChevronDown;
  const toneLabel = status.agentsLoaded
    ? `${TONE_TEXT[status.agentTone]}${status.agentAttention > 0 ? `，${status.agentAttention} 个待处理` : ""}`
    : "Agent 状态未知";

  return (
    <div
      className={`capsule-rail cap-${vertical ? "v" : "h"} edge-${edge}`}
      data-tauri-drag-region
      role="toolbar"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label="胶囊分类导航"
    >
      {/* 表面层：液态翼片的唯一可见轮廓（贴边齐平、两侧外扩），
          绝对定位在按钮之下，不参与 flex 排布 */}
      <CapsuleWing edge={edge} />

      {/* 顶部：Agent 总状态（真实聚合；空闲中性、运行蓝、等待/失败语义色） */}
      <button
        type="button"
        className="cap-orb"
        data-tone={status.agentsLoaded ? status.agentTone : "unknown"}
        data-tip="Agent"
        data-tip-placement={railTipPlacement(edge, expanded, true)}
        data-tip-offset={expanded ? CAPSULE_TIP_INWARD_OFFSET : undefined}
        aria-label={`${toneLabel}，打开 Agent 面板`}
        aria-pressed={expanded && active === "agents"}
        onClick={() => onSelect("agents")}
      >
        <AgentIcon size={18} strokeWidth={1.8} aria-hidden="true" />
        {status.agentAttention > 0 && (
          <span className="cap-orb-badge" aria-hidden="true">
            {status.agentAttention > 9 ? "9+" : status.agentAttention}
          </span>
        )}
      </button>

      {/* 效果图里状态球与分类组之间没有分隔线：状态球靠尺寸/材质已足够分组，
          多一条线只会让轨道看起来像「被切开的工具栏」。 */}
      <div className="cap-nav">
        {RAIL_CATEGORIES.map((c) => {
          const Icon = ICONS[c];
          const isActive = active === c && expanded;
          const badge = c === "tasks" ? status.taskBadge : null;
          const dot =
            c === "agents" && status.agentsLoaded && status.agentTone !== "idle"
              ? status.agentTone
              : null;
          return (
            <button
              key={c}
              type="button"
              className={`cap-btn${isActive ? " is-active" : ""}`}
              data-tip={CATEGORY_LABELS[c]}
              data-tip-placement={railTipPlacement(edge, expanded)}
              data-tip-offset={expanded ? CAPSULE_TIP_INWARD_OFFSET : undefined}
              aria-label={
                c === "tasks" && status.tasksLoaded
                  ? `任务，${status.pending ?? 0} 个待办${status.overdue > 0 ? `，${status.overdue} 个逾期` : ""}`
                  : CATEGORY_LABELS[c]
              }
              aria-pressed={isActive}
              onClick={() => onSelect(c)}
            >
              <span className="cap-icon">
              <Icon size={18} strokeWidth={1.72} aria-hidden="true" />
              {dot && <span className={`cap-dot dot-${dot}`} aria-hidden="true" />}
              {badge && (
                <span className="cap-badge" aria-hidden="true">
                  {badge}
                </span>
              )}
            </span>
              {/* 悬停/选中指示块：只属于四个分类按钮，Agent 端头球不渲染 */}
              <span className="cap-edge-tab" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div className="cap-sep cap-sep-bottom" aria-hidden="true" />

      {/* 底部：收起（箭头朝向屏幕边缘 = 面板实际收起方向）。
          折叠态没有「再收起」这件事，因此保留占位（避免图标在两种状态间跳动）
          但不渲染可见控件，也不进 Tab 序列——不再长期摆一个灰箭头。 */}
      <button
        type="button"
        className="cap-collapse"
        data-inert={expanded ? "false" : "true"}
        data-tip="收起"
        data-tip-placement={railTipPlacement(edge, expanded)}
        data-tip-offset={expanded ? CAPSULE_TIP_INWARD_OFFSET : undefined}
        aria-label={expanded ? "收起功能面板" : "功能面板已收起"}
        aria-disabled={!expanded}
        tabIndex={expanded ? 0 : -1}
        aria-hidden={!expanded}
        onClick={() => {
          if (expanded) onCollapse();
        }}
      >
        <CollapseIcon size={15} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
