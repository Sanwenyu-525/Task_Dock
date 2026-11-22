import type { WidgetItem } from "../../lib/widgets/model";
import type { WidgetSources } from "../../lib/widgets/sources";
import AgentStatusWidget from "./AgentStatusWidget";
import { EfficiencyWidget, FocusTimerWidget } from "./DependencyWidgets";
import NextReminderWidget from "./NextReminderWidget";
import QuickActionsWidget from "./QuickActionsWidget";
import TodayTasksWidget from "./TodayTasksWidget";

export default function WidgetBody({ item, sources }: { item: WidgetItem; sources: WidgetSources }) {
  switch (item.type) {
    case "today-tasks":
      return <TodayTasksWidget config={item.config} />;
    case "next-reminder":
      return <NextReminderWidget />;
    case "agent-status":
      return <AgentStatusWidget />;
    case "quick-actions":
      return <QuickActionsWidget />;
    case "focus-timer":
      return <FocusTimerWidget source={sources.focus} />;
    case "efficiency":
      return <EfficiencyWidget source={sources.efficiency} />;
  }
}
