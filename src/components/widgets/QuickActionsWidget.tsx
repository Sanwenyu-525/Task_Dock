//! 快捷操作微件：只做「跳到现有功能」的入口，不复制任何业务写入逻辑。

import { Clipboard, Inbox, Plus, Workflow } from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { openFullApp } from "../capsule/actions";

const ACTIONS = [
  {
    key: "new-task",
    labelKey: "widgets.quickActions.newTask",
    icon: Plus,
    run: () => {
      useUiStore.getState().setTab("tasks");
      useUiStore.getState().bumpQuickAdd();
    },
  },
  { key: "capture", labelKey: "widgets.quickActions.capture", icon: Inbox, run: () => openFullApp("inbox") },
  { key: "clipboard", labelKey: "widgets.quickActions.clipboard", icon: Clipboard, run: () => openFullApp("clipboard") },
  { key: "workflows", labelKey: "widgets.quickActions.workflows", icon: Workflow, run: () => openFullApp("workflows") },
] as const;

export default function QuickActionsWidget() {
  const { t } = useLocale();
  return (
    <div className="widget-actions">
      {ACTIONS.map((action) => (
        <button key={action.key} className="widget-action-btn" onClick={action.run}>
          <action.icon size={16} aria-hidden="true" />
          <span>{t(action.labelKey)}</span>
        </button>
      ))}
    </div>
  );
}
