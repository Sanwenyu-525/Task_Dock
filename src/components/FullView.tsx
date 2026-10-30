//! 完整模式：左侧垂直导航 + 任务 / Agent / 行动 / 剪贴板 / 历史 / 设置 六个面板。
//!
//! v0.6：由顶部横向标签改为**左侧垂直导航**（两套视觉预设共用同一结构）。
//! - 图标 + 文字，选中态由预设决定（梦幻渐变=淡色药丸，液态玻璃=玻璃胶囊）
//! - 徽标口径与行动中心一致（见下），不新造第二套计数
//! - 底部保留「快速添加」入口，Ctrl+K 与标题栏入口行为一致
//! - 窄窗（< 380px）时只留图标，避免挤压右侧统计卡与筛选行
//! - v0.6：剪贴板正式成为第 4 个入口（不再是覆盖整屏的抽屉）

import { useUiStore, TAB_ORDER, type Tab } from "../store/useUiStore";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore, attentionCount } from "../store/useActionsStore";
import TasksPanel from "./tasks/TasksPanel";
import AgentPanel from "./agents/AgentPanel";
import ActionCenterPanel from "./actions/ActionCenterPanel";
import ClipboardPanel from "./clipboard/ClipboardPanel";
import HistoryPanel from "./history/HistoryPanel";
import SettingsPanel from "./settings/SettingsPanel";
import { ListTodo, Bot, Zap, Clipboard, History, Settings as SettingsIcon, Plus } from "lucide-react";

const TAB_META: Record<Tab, { label: string; icon: typeof ListTodo; badge?: "intervention" | "attention" | "pending" }> = {
  tasks: { label: "任务", icon: ListTodo, badge: "pending" },
  agents: { label: "Agent", icon: Bot, badge: "intervention" },
  actions: { label: "行动", icon: Zap, badge: "attention" },
  clipboard: { label: "剪贴板", icon: Clipboard },
  history: { label: "历史", icon: History },
  settings: { label: "设置", icon: SettingsIcon },
};

// 顺序取自 TAB_ORDER：导航渲染与 Ctrl+1…6 共用同一份定义，不会各自漂移
const TABS = TAB_ORDER.map((id) => ({ id, ...TAB_META[id] }));

export default function FullView() {
  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);
  const bumpQuickAdd = useUiStore((s) => s.bumpQuickAdd);
  const stats = useTasksStore((s) => s.stats);
  const actionFeed = useActionsStore((s) => s.feed);

  // 两个徽标共用行动中心口径：需介入（未确认），不再用原始 waiting/failed 计数，
  // 避免同一状态在标签页与行动中心显示两个不同的数字。
  // 行动中心整体关闭时两个徽标都归零（不显示过期聚合）。
  const pending = stats?.pending ?? 0;
  const actionsEnabled = actionFeed?.enabled !== false;
  const intervention = actionsEnabled ? actionFeed?.counts.intervention ?? 0 : 0;
  const actions = actionsEnabled ? attentionCount(actionFeed) : 0;

  const counts = { intervention, attention: actions, pending };

  return (
    <div className="full-view">
      <nav className="rail" aria-label="主导航">
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
        <div className="rail-foot">
          <button
            className="rail-item rail-add"
            data-tip="快速添加任务 (Ctrl+K)"
            aria-label="快速添加任务"
            onClick={() => {
              setTab("tasks");
              bumpQuickAdd();
            }}
          >
            <span className="rail-icon">
              <Plus size={17} strokeWidth={1.9} />
            </span>
            <span className="rail-label">添加</span>
          </button>
        </div>
      </nav>
      <div className="tab-content">
        {tab === "tasks" && <TasksPanel />}
        {tab === "agents" && <AgentPanel />}
        {tab === "actions" && <ActionCenterPanel />}
        {tab === "clipboard" && <ClipboardPanel />}
        {tab === "history" && <HistoryPanel />}
        {tab === "settings" && <SettingsPanel />}
      </div>
    </div>
  );
}
