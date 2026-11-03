//! 完整模式：左侧垂直导航 + 任务 / Agent / 行动 / 剪贴板 / 收集箱 / 暂存架 / 历史 / 规划中心 / 设置 九个面板。
//!
//! v0.6：由顶部横向标签改为**左侧垂直导航**（两套视觉预设共用同一结构）。
//! - 图标 + 文字，选中态由预设决定（梦幻渐变=淡色药丸，液态玻璃=玻璃胶囊）
//! - 徽标口径与行动中心一致（见下），不新造第二套计数
//! - 「新建任务」置于导航顶部，仅图标（可访问名由 aria-label 提供），复用 Ctrl+K / 标题栏的快速添加行为
//! - 窄窗（< 380px）时只留图标，避免挤压右侧统计卡与筛选行
//! - v0.6：剪贴板正式成为第 4 个入口（不再是覆盖整屏的抽屉）
//! - v0.7：新增「收集箱」（剪贴板之后、历史之前）与「规划中→规划中心」（历史之后、设置之前）入口
//! - v0.8：新增「暂存架」（收集箱之后、历史之前）入口
//!
//! 徽标口径：收集箱徽标 = 未处理捕获条数（useCaptureStore.inboxCount），
//! 进入完整模式时拉取一次，捕获产生/面板处理后由 store 自身刷新，不做轮询。

import { useEffect } from "react";
import { useUiStore, TAB_ORDER, type Tab } from "../store/useUiStore";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore, attentionCount } from "../store/useActionsStore";
import { useCaptureStore } from "../store/useCaptureStore";
import TasksPanel from "./tasks/TasksPanel";
import AgentPanel from "./agents/AgentPanel";
import ActionCenterPanel from "./actions/ActionCenterPanel";
import ClipboardPanel from "./clipboard/ClipboardPanel";
import CaptureInboxPanel from "./inbox/CaptureInboxPanel";
import ShelfPanel from "./shelf/ShelfPanel";
import HistoryPanel from "./history/HistoryPanel";
import PlanningCenterPanel from "./roadmap/PlanningCenterPanel";
import SettingsPanel from "./settings/SettingsPanel";
import { Inbox, ListTodo, Clipboard, History, Map, Settings as SettingsIcon, Plus, Archive } from "lucide-react";
import AgentIcon, { type IconComponent } from "./ui/AgentIcon";
import PointerClickIcon from "./ui/PointerClickIcon";
import { railTipPlacement } from "./capsule/CapsuleRail";

const TAB_META: Record<
  Tab,
  { label: string; icon: IconComponent; badge?: "intervention" | "attention" | "pending" | "inbox" }
> = {
  tasks: { label: "任务", icon: ListTodo, badge: "pending" },
  agents: { label: "Agent", icon: AgentIcon, badge: "intervention" },
  actions: { label: "行动", icon: PointerClickIcon, badge: "attention" },
  clipboard: { label: "剪贴板", icon: Clipboard },
  inbox: { label: "收集箱", icon: Inbox, badge: "inbox" },
  // v0.8：文件暂存架（收集箱之后、历史之前）
  shelf: { label: "暂存架", icon: Archive },
  history: { label: "历史", icon: History },
  // v0.7：规划中心（Tab 身份仍为 roadmap，内置路线图保留为其中一个数据源）
  roadmap: { label: "规划中心", icon: Map },
  settings: { label: "设置", icon: SettingsIcon },
};

// 顺序取自 TAB_ORDER：导航渲染与 Ctrl+1…8 共用同一份定义，不会各自漂移
const TABS = TAB_ORDER.map((id) => ({ id, ...TAB_META[id] }));
// 完整悬浮栏（自由位置、未贴边停靠）：提示方向保持原有语义「图标右侧」，
// 不套用停靠四边朝内映射；形态显式传给纯函数，避免靠 edge 值推断。
const FLOATING_TIP_PLACEMENT = railTipPlacement("floating", null, false);

export default function FullView() {
  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);
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
          {TABS.map((t) => {
            const count = t.badge ? counts[t.badge] : 0;
            return (
              <button
                key={t.id}
                className={`rail-item ${tab === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                // 窄窗下文字标签被隐藏，可访问名必须由 aria-label 兜底；
                // 提示条走统一的 data-tip（原生 title 会弹出系统样式提示）。
                aria-label={count > 0 ? `${t.label}（${count}）` : t.label}
                data-tip={t.label}
                data-tip-placement={FLOATING_TIP_PLACEMENT}
              >
                <span className="rail-icon">
                  <t.icon size={18} strokeWidth={1.75} />
                  {count > 0 && (
                    <em className={`rail-badge ${t.badge === "pending" ? "subtle" : ""}`}>
                      {count > 99 ? "99+" : count}
                    </em>
                  )}
                </span>
                <span className="rail-label">{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      <div className={`tab-content tab-content-${tab}`}>
        {tab === "tasks" && <TasksPanel />}
        {tab === "agents" && <AgentPanel />}
        {tab === "actions" && <ActionCenterPanel />}
        {tab === "clipboard" && <ClipboardPanel />}
        {tab === "inbox" && <CaptureInboxPanel />}
        {tab === "shelf" && <ShelfPanel />}
        {tab === "history" && <HistoryPanel />}
        {tab === "roadmap" && <PlanningCenterPanel />}
        {tab === "settings" && <SettingsPanel />}
      </div>
    </div>
  );
}
