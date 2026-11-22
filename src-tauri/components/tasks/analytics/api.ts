/**
 * 任务统计子视图的 IPC 封装。
 *
 * 集成说明：主窗口业务 IPC 的规范归属是 `src/lib/bridge.ts`；本文件是并行开发期
 * 为避免改动共享文件而设的独立桥接层（与 `src/lib/globalSearchBridge.ts` 同模式）。
 * 集成会话可整体迁入 `bridge.ts`，或保留本文件并在 bridge 中再导出。
 */

import { invokeCommand } from "../../../lib/errors";

export type AnalyticsRange = "day" | "week" | "month";

export interface AnalyticsSummary {
  completed: number;
  recurring_completed: number;
  due: number;
  due_completed: number;
  due_overdue: number;
  completion_rate: number | null;
  overdue_rate: number | null;
}

export interface TrendPoint {
  key: string;
  label: string;
  start: string;
  end: string;
  completed: number;
  due: number;
  due_completed: number;
  due_overdue: number;
  completion_rate: number | null;
  overdue_rate: number | null;
}

export interface CategoryStat {
  category: string;
  completed: number;
  share: number;
}

export interface PriorityStat {
  priority: number;
  completed: number;
  share: number;
}

/** 口径原文由后端返回，前端原样展示，避免口径漂移。 */
export interface AnalyticsDefinitions {
  completed: string;
  completion_rate: string;
  overdue_rate: string;
  trend: string;
  distribution: string;
  history: string;
}

export interface TaskAnalytics {
  range: AnalyticsRange;
  range_label: string;
  range_start: string;
  range_end: string;
  generated_at: string;
  summary: AnalyticsSummary;
  trend: TrendPoint[];
  by_category: CategoryStat[];
  by_priority: PriorityStat[];
  /**
   * 分母完整性：false = 本期存在无法还原的重复任务期次（自动推进 / 补偿跳期 /
   * 主动改期），完成率与逾期率可能偏高。旧后端没有该字段，按 undefined 处理
   * （不显示「不完整」提示，保持兼容）。
   */
  history_complete?: boolean;
  definitions: AnalyticsDefinitions;
}

export function fetchTaskAnalytics(range: AnalyticsRange): Promise<TaskAnalytics> {
  return invokeCommand<TaskAnalytics>("task_analytics", { range }, "读取任务统计");
}
