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
  Inbox,
  LayoutGrid,
  ListTodo,
} from "lucide-react";
import AgentIcon, { type IconComponent } from "../ui/AgentIcon";
import CapsuleWing from "./CapsuleWing";
import {
  RAIL_CATEGORIES,
  type CapsuleCategory,
  type RailCategory,
  type RailStatus,
} from "../../lib/capsuleModel";
import { CAPSULE_GAP_CSS, RAIL_THICKNESS_CSS } from "../../lib/capsuleLayout";
import type { SnapEdge } from "../../lib/edgeSnap";

/** 轨道四个分类按钮的图标。Agent 不在其中：它由顶部状态球直达（AgentIcon）。 */
const ICONS: Record<RailCategory, IconComponent> = {
  tasks: ListTodo,
  inbox: Inbox,
  clipboard: Clipboard,
  apps: LayoutGrid,
};

/** 分类可读名：轨道四类 + Agent 端头球（面板 aria 也用它）。 */
export const CATEGORY_LABELS: Record<CapsuleCategory, string> = {
  tasks: "任务",
  inbox: "收集箱",
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

/**
 * 轨道形态：贴边停靠的胶囊坞 / 完整悬浮栏（自由位置、未停靠、完整展开的栏）。
 * 形态必须显式传入，不能靠 `edge === "top"` 之类偶然值推断，否则以后加边会串台。
 */
export type RailTipForm = "docked" | "floating";

/** 完整悬浮栏保持原有方向语义：提示条出现在图标右侧（与 Agent 面板一致）。 */
const FLOATING_TIP: TipPlacement = "right";

/**
 * 提示方向（纯函数，浮层只消费 `data-tip-placement`）：
 * - `docked`：展开态严格按停靠边朝屏幕内侧（上→下、下→上、左→右、右→左）；
 *   折叠态保持既有已确认行为，沿轨道朝中心（垂直停靠向上、水平停靠向左）。
 * - `floating`：不套四边映射，固定图标右侧；此时 `edge` 必须为 null。
 */
export function railTipPlacement(
  form: RailTipForm,
  edge: SnapEdge | null,
  expanded: boolean,
  lead = false,
): TipPlacement {
  if (form !== "docked" || !edge) return FLOATING_TIP;
  if (expanded) return INWARD[edge];
  const vertical = edge === "left" || edge === "right";
  if (vertical) return lead ? "bottom" : "top";
  return lead ? "right" : "left";
}

/** 分类项图标按钮边长（与 `.cap-btn` 一致）。 */
const CAP_ITEM_CSS = 36;
/** 收起按钮边长（与 `.cap-collapse` 一致）：比图标小，朝内偏移必须按自己的边长算。 */
const CAP_COLLAPSE_CSS = 26;
/** 气泡起点越过「半个轨道厚度 + 轨道/面板间隙 + 区域 AA 内收」后，才能进入
 *  面板可见矩形；落进间隙的像素既不属于区域也不拦截鼠标，会被裁出一条缺边。 */
const TIP_PANEL_INSET_CSS = RAIL_THICKNESS_CSS / 2 + CAPSULE_GAP_CSS + 2;

/**
 * 展开态朝内气泡的外扩距离（CSS px）：锚点靠内侧边到面板可见边的距离。
 * 必须按锚点实际边长换算——36px 图标是 `38-18=20`，26px 收起按钮是 `38-13=25`；
 * 全用 20 会让收起按钮的气泡起点落进间隙 3px，表现为一条缺边。
 */
export function capsuleTipInwardOffset(anchorSize: number): number {
  return TIP_PANEL_INSET_CSS - anchorSize / 2;
}

/** Agent 状态球与四个分类（36px）的外扩距离：20。 */
export const CAPSULE_TIP_INWARD_OFFSET = capsuleTipInwardOffset(CAP_ITEM_CSS);
/** 收起按钮（26px）的外扩距离：25。 */
export const CAPSULE_TIP_COLLAPSE_OFFSET = capsuleTipInwardOffset(CAP_COLLAPSE_CSS);

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
  active: CapsuleCategory;
  expanded: boolean;
  onSelect: (c: CapsuleCategory) => void;
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
        data-tip-placement={railTipPlacement("docked", edge, expanded, true)}
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
          // 徽标来自真实 store：待办数 / 收集箱未处理数；0 或未加载不显示
          const badge = c === "tasks" ? status.taskBadge : c === "inbox" ? status.inboxBadge : null;
          return (
            <button
              key={c}
              type="button"
              className={`cap-btn${isActive ? " is-active" : ""}`}
              data-tip={CATEGORY_LABELS[c]}
              data-tip-placement={railTipPlacement("docked", edge, expanded)}
              data-tip-offset={expanded ? CAPSULE_TIP_INWARD_OFFSET : undefined}
              aria-label={
                c === "tasks" && status.tasksLoaded
                  ? `任务，${status.pending ?? 0} 个待办${status.overdue > 0 ? `，${status.overdue} 个逾期` : ""}`
                  : c === "inbox" && status.inboxCount !== null
                    ? `收集箱，${status.inboxCount} 条未处理`
                    : CATEGORY_LABELS[c]
              }
              aria-pressed={isActive}
              onClick={() => onSelect(c)}
            >
              <span className="cap-icon">
              <Icon size={18} strokeWidth={1.72} aria-hidden="true" />
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
        data-tip-placement={railTipPlacement("docked", edge, expanded)}
        data-tip-offset={expanded ? CAPSULE_TIP_COLLAPSE_OFFSET : undefined}
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
