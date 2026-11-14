//! 快捷操作微件：只做「跳到现有功能」的入口，不复制任何业务写入逻辑。
//! 收集箱/剪贴板留在主窗快捷面板（实时页面）；工作流是完整功能，
//! 直达唯一工作台对应页（不经主窗摘要交接页二次跳转）。

import { Clipboard, Inbox, Plus, Workflow } from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { openFullApp, openWorkbenchPage } from "../capsule/actions";

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
  { key: "workflows", labelKey: "widgets.quickActions.workflows", icon: Workflow, run: () => void openWorkbenchPage("workflows") },
] as const;

export type QuickActionKey = (typeof ACTIONS)[number]["key"];

export interface QuickActionsWidgetProps {
  /** 独立桌面窗口：把动作转交主窗口执行；缺省使用本窗口导航。 */
  onAction?: (key: QuickActionKey) => void;
}

export default function QuickActionsWidget({ onAction }: QuickActionsWidgetProps = {}) {
  const { t } = useLocale();
  return (
    <div className="widget-actions">
      {ACTIONS.map((action) => (
        <button
          key={action.key}
          className="widget-action-btn"
          onClick={() => (onAction ? onAction(action.key) : action.run())}
        >
          <action.icon size={16} aria-hidden="true" />
          <span>{t(action.labelKey)}</span>
        </button>
      ))}
    </div>
  );
}
