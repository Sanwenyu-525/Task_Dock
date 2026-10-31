//! 分类胶囊的左侧（或顶/底）轨道：Agent 总状态 + 四个分类入口 + 收起按钮。
//!
//! 只渲染，不做决策：状态来自 `railStatus()`（真实 store 聚合），
//! 相位来自 `useEdgeSnapStore`，当前分类来自 `useCapsuleStore`。
//!
//! 交互约定：
//! - 点击分类 = 展开该分类面板；再次点击当前分类 = 收起（由 CapsuleDock 处理）；
//! - 轨道空白处可拖动窗口（`data-tauri-drag-region`），按钮区域不触发拖动；
//! - 不使用 `data-tip`：胶囊是 Win32 区域裁剪窗口，提示气泡会画在区域之外而不可见，
//!   无障碍信息一律走 `aria-label`。

import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clipboard,
  LayoutGrid,
  ListTodo,
  Sparkles,
} from "lucide-react";
import { RAIL_CATEGORIES, type RailCategory, type RailStatus } from "../../lib/capsuleModel";
import type { SnapEdge } from "../../lib/edgeSnap";

const ICONS: Record<RailCategory, typeof ListTodo> = {
  tasks: ListTodo,
  agents: Bot,
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
  active: RailCategory | null;
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
      {/* 顶部：Agent 总状态（真实聚合；空闲中性、运行蓝、等待/失败语义色） */}
      <button
        type="button"
        className="cap-orb"
        data-tone={status.agentsLoaded ? status.agentTone : "unknown"}
        aria-label={`${toneLabel}，打开 Agent 面板`}
        aria-pressed={active === "agents"}
        onClick={() => onSelect("agents")}
      >
        <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
        {status.agentAttention > 0 && (
          <span className="cap-orb-badge" aria-hidden="true">
            {status.agentAttention > 9 ? "9+" : status.agentAttention}
          </span>
        )}
      </button>

      <div className="cap-sep" aria-hidden="true" />

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
              aria-label={
                c === "tasks" && status.tasksLoaded
                  ? `任务，${status.pending ?? 0} 个待办${status.overdue > 0 ? `，${status.overdue} 个逾期` : ""}`
                  : CATEGORY_LABELS[c]
              }
              aria-pressed={isActive}
              onClick={() => onSelect(c)}
            >
              <span className="cap-icon">
                <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
                {dot && <span className={`cap-dot dot-${dot}`} aria-hidden="true" />}
              </span>
              {badge && (
                <span className="cap-badge" aria-hidden="true">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="cap-sep" aria-hidden="true" />

      {/* 底部：收起（箭头朝向屏幕边缘 = 面板实际收起方向） */}
      <button
        type="button"
        className="cap-collapse"
        aria-label={expanded ? "收起功能面板" : "功能面板已收起"}
        aria-disabled={!expanded}
        onClick={() => {
          if (expanded) onCollapse();
        }}
      >
        <CollapseIcon size={15} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
