//! 快捷操作微件：只做「跳到现有功能」的入口，不复制任何业务写入逻辑。

import { Clipboard, Inbox, Plus, Workflow } from "lucide-react";

import { useUiStore } from "../../store/useUiStore";
import { openFullApp } from "../capsule/actions";

const ACTIONS = [
  {
    key: "new-task",
    label: "新建任务",
    icon: Plus,
    run: () => {
      useUiStore.getState().setTab("tasks");
      useUiStore.getState().bumpQuickAdd();
    },
  },
  { key: "capture", label: "快速收集", icon: Inbox, run: () => openFullApp("inbox") },
  { key: "clipboard", label: "剪贴板", icon: Clipboard, run: () => openFullApp("clipboard") },
  { key: "workflows", label: "工作流", icon: Workflow, run: () => openFullApp("workflows") },
] as const;

export default function QuickActionsWidget() {
  return (
    <div className="widget-actions">
      {ACTIONS.map((action) => (
        <button key={action.key} className="widget-action-btn" onClick={action.run}>
          <action.icon size={16} aria-hidden="true" />
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}
