//! 完整模式：左侧垂直导航 + 任务 / Agent / 应用 / 行动 / 剪贴板 / 收集与暂存 / 工作流 / 历史 / 规划中心 / 设置 **十个视觉入口**。
//! 应用中心（v0.10）复用既有导航目标体系，三端（侧栏 / 胶囊 / 设置）共享同一份数据。
//!
//! v0.6：由顶部横向标签改为**左侧垂直导航**（两套视觉预设共用同一结构）。
//! - 图标 + 文字，选中态由预设决定（梦幻渐变=淡色药丸，液态玻璃=玻璃胶囊）
//! - 徽标口径与行动中心一致（见下），不新造第二套计数
//! - 「新建任务」置于导航顶部，仅图标（可访问名由 aria-label 提供），复用 Ctrl+K / 标题栏的快速添加行为
//! - 窄窗（< 380px）时只留图标，避免挤压右侧统计卡与筛选行
//! - v0.6：剪贴板正式成为第 4 个入口（不再是覆盖整屏的抽屉）
//! - v0.7：新增「收集箱」与「规划中→规划中心」入口
//! - v0.8：新增「暂存架」入口，随后与收集箱**合并为「收集与暂存」单一视觉入口**
//!   （页面内双子页签：快速收集 | 文件暂存）。
//! - v0.10：新增「应用」视觉入口（Agent 之后、行动之前）
//!
//! 逻辑 Tab 与快捷键：`TAB_ORDER` 仍是 10 个逻辑 Tab（快捷键 Ctrl+1…9 与 Ctrl+0 的
//! 事实源，Ctrl+5=快速收集、Ctrl+6=文件暂存）；「应用」只存在于视觉顺序 `RAIL_ORDER`，
//! **不占用 Ctrl+数字**，已有快捷键语义不漂移。视觉合并只发生在 RAIL 导航渲染层。
//!
//! 徽标口径：合并入口徽标 = 未处理捕获条数（useCaptureStore.inboxCount），
//! 即「待处理收集内容」；暂存条目总数**不计入**未处理徽标。

import { useEffect } from "react";
import { useUiStore, RAIL_ORDER, type Tab } from "../store/useUiStore";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore, attentionCount } from "../store/useActionsStore";
import { useCaptureStore } from "../store/useCaptureStore";
import TasksPanel from "./tasks/TasksPanel";
import AgentPanel from "./agents/AgentPanel";
import AppsPanel from "./apps/AppsPanel";
import ActionCenterPanel from "./actions/ActionCenterPanel";
import ClipboardPanel from "./clipboard/ClipboardPanel";
import CollectionPanel from "./collection/CollectionPanel";
import WorkflowsPanel from "./workflows/WorkflowsPanel";
import HistoryPanel from "./history/HistoryPanel";
import PlanningCenterPanel from "./roadmap/PlanningCenterPanel";
import SettingsPanel from "./settings/SettingsPanel";
import WidgetsPanel from "./widgets/WidgetsPanel";
import { WIDGET_SOURCES } from "./widgets/liveSources";
import { Inbox, ListTodo, Clipboard, History, Map, Settings as SettingsIcon, Plus, Workflow, LayoutGrid, Blocks } from "lucide-react";
import AgentIcon, { type IconComponent } from "./ui/AgentIcon";
import PointerClickIcon from "./ui/PointerClickIcon";
import { railTipPlacement } from "./capsule/CapsuleRail";

const TAB_META: Record<
  Tab,
  { label: string; icon: IconComponent; badge?: "intervention" | "attention" | "pending" | "inbox" }
> = {
  tasks: { label: "任务", icon: ListTodo, badge: "pending" },
  agents: { label: "Agent", icon: AgentIcon, badge: "intervention" },
  // v0.10：应用中心（Agent 之后、行动之前）；仅视觉入口，不占快捷键
  apps: { label: "应用", icon: LayoutGrid },
  // v0.11：桌面微件（应用之后、行动之前）；仅视觉入口，不占快捷键
  widgets: { label: "微件", icon: Blocks },
  actions: { label: "行动", icon: PointerClickIcon, badge: "attention" },
  clipboard: { label: "剪贴板", icon: Clipboard },
  inbox: { label: "收集箱", icon: Inbox, badge: "inbox" },
  shelf: { label: "暂存架", icon: Inbox },
  // v0.9：一键工作流（暂存架之后、历史之前）
  workflows: { label: "工作流", icon: Workflow },
  history: { label: "历史", icon: History },
  // v0.7：规划中心（Tab 身份仍为 roadmap，内置路线图保留为其中一个数据源）
  roadmap: { label: "规划中心", icon: Map },
  settings: { label: "设置", icon: SettingsIcon },
};

/** 侧边栏视觉入口：inbox 与 shelf 合并为一个入口（tabs 列出其覆盖的逻辑 Tab）。 */
interface RailEntry {
  key: string;
  label: string;
  icon: IconComponent;
  badge?: "intervention" | "attention" | "pending" | "inbox";
  tabs: readonly Tab[];
}

/**
 * 视觉导航（按 RAIL_ORDER 折叠）：shelf 折入 inbox 的「收集与暂存」入口，
 * 其余 1:1。快捷键仍按 TAB_ORDER 逐个映射（Ctrl+5=inbox、Ctrl+6=shelf），不偏移；
 * 仅视觉入口「应用」不占用数字键。
 */
const RAIL_ENTRIES: RailEntry[] = RAIL_ORDER.flatMap((id): RailEntry[] => {
  if (id === "shelf") return []; // 折入收集与暂存
  if (id === "inbox") {
    return [{ key: "collection", label: "收集与暂存", icon: Inbox, badge: "inbox", tabs: ["inbox", "shelf"] }];
  }
  return [{ key: id, label: TAB_META[id].label, icon: TAB_META[id].icon, badge: TAB_META[id].badge, tabs: [id] }];
});

// 完整悬浮栏（自由位置、未贴边停靠）：提示方向保持原有语义「图标右侧」，
// 不套用停靠四边朝内映射；形态显式传给纯函数，避免靠 edge 值推断。
const FLOATING_TIP_PLACEMENT = railTipPlacement("floating", null, false);

export default function FullView() {
  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);
  const collectionSub = useUiStore((s) => s.collectionSub);
  const setCollectionSub = useUiStore((s) => s.setCollectionSub);
  const bumpQuickAdd = useUiStore((s) => s.bumpQuickAdd);
  const stats = useTasksStore((s) => s.stats);
  const actionFeed = useActionsStore((s) => s.feed);
  const inboxCount = useCaptureStore((s) => s.inboxCount);
  const refreshInboxCount = useCaptureStore((s) => s.refreshInboxCount);

  // 进入完整模式先拿一次未处理计数（徽标）；条目列表在进入收集箱时由面板加载。
  useEffect(() => {
    void refreshInboxCount();
  }, [refreshInboxCount]);

  // 两个徽标共用行动中心口径：需介入（未确认），不再用原始 waiting/failed 计数，
  // 避免同一状态在标签页与行动中心显示两个不同的数字。
  // 行动中心整体关闭时两个徽标都归零（不显示过期聚合）。
  const pending = stats?.pending ?? 0;
  const actionsEnabled = actionFeed?.enabled !== false;
  const intervention = actionsEnabled ? actionFeed?.counts.intervention ?? 0 : 0;
  const actions = actionsEnabled ? attentionCount(actionFeed) : 0;

  const counts = { intervention, attention: actions, pending, inbox: inboxCount };

  return (
    <div className="full-view">
      <nav className="rail" aria-label="主导航">
        <div className="rail-head">
          <button
            className="rail-new-task"
            data-tip="新建任务 (Ctrl+K)"
            data-tip-placement={FLOATING_TIP_PLACEMENT}
            aria-label="新建任务"
            onClick={() => {
              setTab("tasks");
              bumpQuickAdd();
            }}
          >
            <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
        <div className="rail-items">
          {RAIL_ENTRIES.map((entry) => {
            const count = entry.badge ? counts[entry.badge] : 0;
            const active = entry.tabs.includes(tab);
            // 合并入口点击打开「上一次的子页」（无历史时由 collectionSub 默认 inbox）；
            // 笔记子页没有对应逻辑 Tab，回到入口时先落到 inbox/shelf 再恢复 notes 子页。
            const target =
              entry.tabs.length > 1
                ? collectionSub === "notes"
                  ? entry.tabs[0]
                  : collectionSub
                : entry.tabs[0];
            // 徽标语义在提示条中如实说明：数字只代表待处理收集内容
            const tip =
              entry.key === "collection" && count > 0
                ? `${entry.label}（${count} 条待处理收集）`
                : entry.label;
            return (
              <button
                key={entry.key}
                className={`rail-item ${active ? "active" : ""}`}
                onClick={() => {
                  if (entry.key === "collection" && collectionSub === "notes") {
                    setTab(entry.tabs[0]);
                    setCollectionSub("notes");
                    return;
                  }
                  setTab(target);
                }}
                aria-current={active ? "page" : undefined}
                // 窄窗下文字标签被隐藏，可访问名必须由 aria-label 兜底；
                // 提示条走统一的 data-tip（原生 title 会弹出系统样式提示）。
                aria-label={count > 0 ? `${entry.label}（${count}）` : entry.label}
                data-tip={tip}
                data-tip-placement={FLOATING_TIP_PLACEMENT}
              >
                <span className="rail-icon">
                  <entry.icon size={18} strokeWidth={1.75} />
                  {count > 0 && (
                    <em className={`rail-badge ${entry.badge === "pending" ? "subtle" : ""}`}>
                      {count > 99 ? "99+" : count}
                    </em>
                  )}
                </span>
                <span className="rail-label">{entry.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      <div className={`tab-content tab-content-${tab}`}>
        {tab === "tasks" && <TasksPanel />}
        {tab === "agents" && <AgentPanel />}
        {tab === "apps" && <AppsPanel />}
        {tab === "widgets" && <WidgetsPanel sources={WIDGET_SOURCES} />}
        {tab === "actions" && <ActionCenterPanel />}
        {tab === "clipboard" && <ClipboardPanel />}
        {/* 收集与暂存：inbox / shelf 两个逻辑 Tab 共用同一组合页 */}
        {(tab === "inbox" || tab === "shelf") && <CollectionPanel />}
        {tab === "workflows" && <WorkflowsPanel />}
        {tab === "history" && <HistoryPanel />}
        {tab === "roadmap" && <PlanningCenterPanel />}
        {tab === "settings" && <SettingsPanel />}
      </div>
    </div>
  );
}
