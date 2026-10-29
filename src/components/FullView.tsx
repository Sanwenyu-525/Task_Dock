//! 完整模式：任务 / Agent / 行动 / 历史 / 设置 五个标签页（徽标使用全局统计）。

import { useUiStore, type Tab } from "../store/useUiStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore, attentionCount } from "../store/useActionsStore";
import TasksPanel from "./tasks/TasksPanel";
import AgentPanel from "./agents/AgentPanel";
import ActionCenterPanel from "./actions/ActionCenterPanel";
import HistoryPanel from "./history/HistoryPanel";
import SettingsPanel from "./settings/SettingsPanel";
import { ListTodo, Bot, Zap, History, Settings as SettingsIcon } from "lucide-react";
import { liveRuns } from "../lib/agentTree";

const TABS: { id: Tab; label: string; icon: typeof ListTodo }[] = [
  { id: "tasks", label: "任务", icon: ListTodo },
  { id: "agents", label: "Agent", icon: Bot },
  { id: "actions", label: "行动", icon: Zap },
  { id: "history", label: "历史", icon: History },
  { id: "settings", label: "设置", icon: SettingsIcon },
];

export default function FullView() {
  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);
  const agents = useAgentsStore((s) => s.snapshot);
  const stats = useTasksStore((s) => s.stats);
  const actionFeed = useActionsStore((s) => s.feed);

  // 徽标使用全局实时集合（waiting/failed 近期事件），不依赖筛选后的任务列表
  const attention = liveRuns(agents?.runs ?? []).filter(
    (r) => r.status === "waiting" || r.status === "failed",
  ).length;
  const pending = stats?.pending ?? 0;
  const actions = attentionCount(actionFeed);

  return (
    <div className="full-view">
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
          >
            <t.icon size={14} />
            <span>{t.label}</span>
            {t.id === "agents" && attention > 0 && <em className="badge">{attention}</em>}
            {t.id === "actions" && actions > 0 && <em className="badge">{actions}</em>}
            {t.id === "tasks" && pending > 0 && <em className="badge subtle">{pending}</em>}
          </button>
        ))}
      </nav>
      <div className="tab-content">
        {tab === "tasks" && <TasksPanel />}
        {tab === "agents" && <AgentPanel />}
        {tab === "actions" && <ActionCenterPanel />}
        {tab === "history" && <HistoryPanel />}
        {tab === "settings" && <SettingsPanel />}
      </div>
    </div>
  );
}
