//! 分类胶囊的左侧（或顶/底）轨道：Agent 总状态 + 五个分类入口 + 形态出口。
//!
//! 只渲染，不做决策：状态来自 `railStatus()`（真实 store 聚合），
//! 相位来自 `useEdgeSnapStore`，当前分类来自 `useCapsuleStore`。
//! 底部入口自上而下：展开完整面板 → 收起为极简标签。
//! 功能面板的收起不再提供独立箭头按钮：点击当前分类、Escape 或点击面板外
//! 已覆盖全部收起路径，底部再放一个箭头属于重复入口且占用轨道空间。
//!
//! 交互约定：
//! - 点击分类 = 展开该分类面板；再次点击当前分类 = 收起（由 CapsuleDock 处理）；
//! - 轨道空白处可拖动窗口（`data-tauri-drag-region`），按钮区域不触发拖动；
//! - 使用 `data-tip` 提供悬停提示（文案就是图标名，复用全局 `TooltipLayer`）；
//!   但胶囊是 Win32 区域裁剪窗口（`SetWindowRgn`），气泡必须落在可见区域内：
//!   展开态指向**屏幕内侧（面板侧）**，四个停靠边做镜像（见 `railTipPlacement`）；
//!   折叠态只有翼片可画，退回沿轨道朝中心的方向。
//! - 无障碍信息仍以 `aria-label` 为准（它比提示文案更完整，例如带待办数）。

import { useEffect, useMemo, useRef, useState } from "react";
import { Expand, Shrink } from "lucide-react";
import CapsuleWing from "./CapsuleWing";
import {
  type CapsuleCategory,
  type RailStatus,
} from "../../lib/capsuleModel";
import { navEntry, type NavEntry } from "../../lib/navigationRegistry";
import { useNavigationLayout } from "../../lib/navigationLayout";
import { useCapsuleStore } from "../../store/useCapsuleStore";
import { CAPSULE_GAP_CSS, RAIL_THICKNESS_CSS } from "../../lib/capsuleLayout";
import { attachDragCursorSession } from "../../lib/dragCursorSession";
import type { SnapEdge } from "../../lib/edgeSnap";
import { t } from "../../i18n";

/** 分类可读名：轨道五类 + Agent 端头球（面板 aria 也用它）。 */
// getter 保持既有「点访问」调用不变，读取时取当前语言。
export const CATEGORY_LABELS: Record<CapsuleCategory, string> = {
  get tasks() {
    return t("capsule.category.tasks");
  },
  get inbox() {
    return t("capsule.category.inbox");
  },
  get agents() {
    return t("capsule.category.agents");
  },
  get clipboard() {
    return t("capsule.category.clipboard");
  },
  get apps() {
    return t("capsule.category.apps");
  },
  get roadmap() {
    return t("capsule.category.roadmap");
  },
};

const TONE_TEXT: Record<RailStatus["agentTone"], string> = {
  get idle() {
    return t("capsule.tone.idle");
  },
  get running() {
    return t("capsule.tone.running");
  },
  get waiting() {
    return t("capsule.tone.waiting");
  },
  get failed() {
    return t("capsule.tone.failed");
  },
  get disconnected() {
    return t("capsule.tone.disconnected");
  },
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
 *   折叠态保持既有已确认行为，沿轨道朝中心（垂直停靠向上、水平停靠向左）；
 *   但第一个分类位于轨道中心之前，朝中心应改为向下/向右，否则 3 字气泡会
 *   伸进肩部曲面被 `SetWindowRgn` 裁掉（5 分类后内容组不再自身居中）。
 * - `floating`：不套四边映射，固定图标右侧；此时 `edge` 必须为 null。
 */
export function railTipPlacement(
  form: RailTipForm,
  edge: SnapEdge | null,
  expanded: boolean,
  lead = false,
  first = false,
): TipPlacement {
  if (form !== "docked" || !edge) return FLOATING_TIP;
  if (expanded) return INWARD[edge];
  const vertical = edge === "left" || edge === "right";
  if (vertical) return lead || first ? "bottom" : "top";
  return lead || first ? "right" : "left";
}

/** 分类项图标按钮边长（与 `.cap-btn` 一致）。 */
const CAP_ITEM_CSS = 36;
/** 收起按钮边长（与 `.cap-collapse` 一致）：比图标小，朝内偏移必须按自己的边长算。 */
const CAP_COLLAPSE_CSS = 26;
/** 气泡起点越过「半个轨道厚度 + 轨道/面板间隙 + 区域 AA 内收」后，才能进入
 *  面板可见矩形；落进间隙的像素既不属于区域也不拦截鼠标，会被裁出一条缺边。 */
const TIP_PANEL_INSET_CSS = RAIL_THICKNESS_CSS / 2 + CAPSULE_GAP_CSS + 2;
/**
 * 水平停靠（上/下）时 Agent 端头球的额外内推距离。
 *
 * 端头球贴着轨道左端：面板带 24px 圆角，气泡若只外扩 20px，左上/左下角会落在
 * 面板圆角之外被 `SetWindowRgn` 裁掉。多推 24px 让气泡越过圆角切点；垂直停靠时
 * 端头球远离面板上下角，仍使用统一外扩量。
 */
const TIP_ORB_HORIZONTAL_EXTRA_CSS = 24;

/**
 * 展开态朝内气泡的外扩距离（CSS px）：锚点靠内侧边到面板可见边的距离。
 * 必须按锚点实际边长换算——36px 图标是 `38-18=20`，26px 收起按钮是 `38-13=25`；
 * 全用 20 会让收起按钮的气泡起点落进间隙 3px，表现为一条缺边。
 */
export function capsuleTipInwardOffset(anchorSize: number): number {
  return TIP_PANEL_INSET_CSS - anchorSize / 2;
}

/** Agent 状态球与五个分类（36px）的外扩距离：20。 */
export const CAPSULE_TIP_INWARD_OFFSET = capsuleTipInwardOffset(CAP_ITEM_CSS);
/** 收起按钮（26px）的外扩距离：25。 */
export const CAPSULE_TIP_COLLAPSE_OFFSET = capsuleTipInwardOffset(CAP_COLLAPSE_CSS);

/**
 * 轨道拖拽光标会话：轨道空白处按下（事件 target 自身带 `data-tauri-drag-region`）
 * 时进入 `is-dragging`（grabbing）。结束信号、起始守卫、会话序号与监听摘除
 * 统一在 `lib/dragCursorSession`（与标题栏、工具面板标题、微件同一套），
 * 其中原生 `WM_EXITSIZEMOVE` 让「松手后鼠标静止」也能立即复位光标。
 * 这里只把会话状态映射成 React 输出：轨道重渲染会用 className 覆盖直接改的 DOM 类，
 * 两者必须一致。按钮自身不带 drag-region，按下既不进入会话，也不会被误判为拖动。
 */
function useRailDragCursor() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const session = attachDragCursorSession(root, { onActiveChange: setDragging });
    return () => session.dispose();
  }, []);

  return { railRef: rootRef, dragging };
}

export default function CapsuleRail({
  edge,
  status,
  active,
  expanded,
  onSelect,
  onCollapse,
  onForm,
  onTab,
}: {
  edge: SnapEdge;
  status: RailStatus;
  /** 当前分类恒有值（折叠态也保留），高亮与否由 `expanded` 决定 */
  active: CapsuleCategory;
  expanded: boolean;
  onSelect: (c: CapsuleCategory) => void;
  onCollapse: () => void;
  /** 可选：切到「完整面板」停靠形态（未启用吸附时缺省）。 */
  onForm?: () => void;
  /** 可选：收起为极简标签（Edge Tab）；未启用吸附时缺省。 */
  onTab?: () => void;
}) {
  const vertical = edge === "left" || edge === "right";
  const { railRef, dragging } = useRailDragCursor();
  const toneLabel = status.agentsLoaded
    ? `${TONE_TEXT[status.agentTone]}${
        status.agentAttention > 0 ? t("capsule.attention", { n: status.agentAttention }) : ""
      }`
    : t("capsule.tone.unknown");
  // 折叠态窗口只剩 56px 翼片并受 Win32 区域裁切：长文案横跨厚度时会被切掉内缘。
  // 折叠态统一切到紧凑气泡，并取消视口留白（8px 留白同样会把气泡推进轨道）。
  const compactTipProps = expanded
    ? {}
    : { "data-tip-compact": "1", "data-tip-padding": "0" };
  // Agent 状态球在水平停靠时靠近面板左缘：展开态也使用紧凑气泡，
  // 否则气泡中心对齐图标后会越出面板可见矩形的左边界。
  const orbTipProps = { "data-tip-compact": "1" };
  const orbCompactProps = expanded
    ? orbTipProps
    : { ...orbTipProps, "data-tip-padding": "0" };

  // ── 入口显隐与排序（统一导航架构）──────────────────────────────────
  // 只过滤图标渲染：外轮廓、吸附与几何全部由 capsuleLayout / Win32 区域决定，
  // **不随可见数量变化**；隐藏 Agent 状态球不影响后台监控与事件接收。
  const layout = useNavigationLayout();
  const capsuleEntries = useMemo(
    () =>
      layout.capsule
        .map((id) => navEntry(id))
        .filter(
          (entry): entry is NavEntry =>
            entry !== undefined && entry.surfaces.includes("capsule"),
        ),
    [layout.capsule],
  );
  const orbEntry = capsuleEntries.find((entry) => entry.id === "agents");
  // 过滤结果必须保持引用稳定：`visibleCategories` 的下游 effect 以它为依赖，
  // 每次渲染都新建数组会让 effect 在每次渲染后重跑（虽无状态写入，仍是多余工作）。
  const categoryEntries = useMemo(
    () =>
      capsuleEntries.filter(
        (entry) => entry.id !== "agents" && entry.capsuleCategory !== undefined,
      ),
    [capsuleEntries],
  );
  // 合法分类集合包含 Agent 端头球：只留状态球时也能切到 Agent，而不是停在隐藏分类。
  const visibleCategories = useMemo(() => {
    const list: CapsuleCategory[] = [];
    if (orbEntry) list.push("agents");
    for (const entry of categoryEntries) {
      if (entry.capsuleCategory) list.push(entry.capsuleCategory);
    }
    return list;
  }, [orbEntry, categoryEntries]);
  const firstVisibleCategory = visibleCategories[0];

  // 当前分类被用户隐藏时，静默切到仍可见的第一个分类，避免幽灵选中态或空白面板。
  // 直接写 UI Store 而不是调用 onSelect：不能因为配置变化就自动展开面板。
  // 全部分类都被隐藏时收起面板：宁可回到折叠态，也不展示一个没有入口的面板。
  useEffect(() => {
    if (visibleCategories.includes(active)) return;
    if (firstVisibleCategory) useCapsuleStore.getState().setActive(firstVisibleCategory);
    else if (expanded) onCollapse();
  }, [active, visibleCategories, firstVisibleCategory, expanded, onCollapse]);

  return (
    <div
      ref={railRef}
      className={[
        "capsule-rail",
        `cap-${vertical ? "v" : "h"}`,
        `edge-${edge}`,
        "ui-drag-surface",
        "ui-drag-session",
        dragging ? "is-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-tauri-drag-region
      role="toolbar"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={t("capsule.railAria")}
    >
      {/* 表面层：液态翼片的唯一可见轮廓（贴边齐平、两侧外扩），
          绝对定位在按钮之下，不参与 flex 排布 */}
      <CapsuleWing edge={edge} />

      {/* 顶部：Agent 总状态（真实聚合；空闲中性、运行蓝、等待/失败语义色）。
          显隐由注册中心配置控制；隐藏只影响图标，不停止监控与事件接收。 */}
      {orbEntry && (
        <button
          type="button"
          className="cap-orb"
          data-tone={status.agentsLoaded ? status.agentTone : "unknown"}
          data-tip={CATEGORY_LABELS.agents}
          data-tip-placement={railTipPlacement("docked", edge, expanded, true)}
          data-tip-offset={
            expanded
              ? CAPSULE_TIP_INWARD_OFFSET + (vertical ? 0 : TIP_ORB_HORIZONTAL_EXTRA_CSS)
              : undefined
          }
          {...orbCompactProps}
          aria-label={t("capsule.openAgents", { label: toneLabel })}
          aria-pressed={expanded && active === "agents"}
          onClick={() => onSelect("agents")}
        >
          <orbEntry.icon size={18} strokeWidth={1.8} aria-hidden="true" />
          {status.agentAttention > 0 && (
            <span className="cap-orb-badge" aria-hidden="true">
              {status.agentAttention > 9 ? "9+" : status.agentAttention}
            </span>
          )}
        </button>
      )}

      {/* 效果图里状态球与分类组之间没有分隔线：状态球靠尺寸/材质已足够分组，
          多一条线只会让轨道看起来像「被切开的工具栏」。 */}
      <div className="cap-nav">
        {categoryEntries.map((entry, index) => {
          const c = entry.capsuleCategory as CapsuleCategory;
          const Icon = entry.icon;
          const isActive = active === c && expanded;
          // 徽标来自真实 store：待办数 / 收集箱未处理数；0 或未加载不显示
          const badge = c === "tasks" ? status.taskBadge : c === "inbox" ? status.inboxBadge : null;
          return (
            <button
              key={entry.id}
              type="button"
              className={`cap-btn${isActive ? " is-active" : ""}`}
              /* 折叠态只剩 56px 翼片：4 字分类名（规划中心）的气泡会横向超出
                 可见区域，折叠时改用 2 字紧凑文案；展开态仍显示完整名称。 */
              data-tip={
                expanded || c !== "roadmap"
                  ? CATEGORY_LABELS[c]
                  : t("capsule.category.roadmapShort")
              }
              data-tip-placement={railTipPlacement("docked", edge, expanded, false, index === 0)}
              data-tip-offset={expanded ? CAPSULE_TIP_INWARD_OFFSET : undefined}
              {...compactTipProps}
              aria-label={
                c === "tasks" && status.tasksLoaded
                  ? status.overdue > 0
                    ? t("capsule.tasksOverdueAria", {
                        pending: status.pending ?? 0,
                        overdue: status.overdue,
                      })
                    : t("capsule.tasksAria", { pending: status.pending ?? 0 })
                  : c === "inbox" && status.inboxCount !== null
                    ? t("capsule.inboxAria", { count: status.inboxCount })
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
              {/* 悬停/选中指示块：只属于分类按钮，Agent 端头球不渲染 */}
              <span className="cap-edge-tab" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div className="cap-sep cap-sep-bottom" aria-hidden="true" />

      {/* 形态切换：把停靠展示从「胶囊」换成完整窗口（设置/右键菜单之外的最小入口）。
          折叠态同样可用（这是离开胶囊形态的轻量出口），文案与图标复用轨道视觉。
          这里只切换**本次停靠会话**的临时形态，不写持久化默认吸附方式。 */}
      {onForm && (
        <button
          type="button"
          className="cap-collapse cap-form"
          /* 折叠态只保留「完整面板 / 收起」两个短词：完整提示在展开态仍可读，
             `aria-label` 两种状态都保持完整语义 */
          data-tip={expanded ? t("capsule.toFullTip") : t("capsule.toFull")}
          data-tip-placement={railTipPlacement("docked", edge, expanded)}
          data-tip-offset={expanded ? CAPSULE_TIP_COLLAPSE_OFFSET : undefined}
          {...compactTipProps}
          aria-label={t("capsule.toFull")}
          onClick={onForm}
        >
          <Expand size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      )}

      {/* 极简吸附态入口：紧贴在「完整面板」按钮下方，尺寸/材质/焦点与它完全一致；
          图标四角朝内（与 Expand 的朝外四角相反），一眼可分。
          语义是 Capsule → Edge Tab，绝不接完整面板的收起逻辑。 */}
      {onTab && (
        <button
          type="button"
          className="cap-collapse cap-to-tab"
          data-tip={expanded ? t("capsule.toTabTip") : t("capsule.collapse")}
          data-tip-placement={railTipPlacement("docked", edge, expanded)}
          data-tip-offset={expanded ? CAPSULE_TIP_COLLAPSE_OFFSET : undefined}
          {...compactTipProps}
          aria-label={t("capsule.toTabAria")}
          onClick={onTab}
        >
          <Shrink size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      )}

    </div>
  );
}
