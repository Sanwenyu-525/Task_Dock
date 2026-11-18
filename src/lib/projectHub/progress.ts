/**
 * 进度计算：四类指标分开返回，空分母一律 null。
 *
 * - 任务完成率：任务 `completed / 全部`；
 * - 阶段完成率：阶段内「功能 + 必需交付物」完成率；
 * - 里程碑完成率：里程碑完成数；
 * - 项目整体：有数据的阶段的算术平均；完全没有阶段数据时回退任务完成率并标注来源。
 *
 * 禁止把任务、阶段、里程碑混成一个不透明百分比。
 */

import type {
  MilestoneProgressInput,
  PhaseProgressInput,
  ProgressMetric,
  ProgressSnapshot,
  ProjectProgressInput,
  TaskProgressInput,
} from "./types";

function percentOf(completed: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((completed / total) * 1000) / 10;
}

function metric(
  completed: number,
  total: number,
  source: ProgressMetric["source"],
  note: string,
): ProgressMetric {
  return { completed, total, percent: percentOf(completed, total), source, note };
}

export function calculateTaskProgress(tasks: TaskProgressInput[]): ProgressMetric {
  const completed = tasks.filter((task) => task.status === "completed").length;
  return metric(completed, tasks.length, "tasks", tasks.length === 0 ? "暂无任务" : "任务完成数 / 全部任务");
}

export function calculatePhaseProgress(phase: PhaseProgressInput): ProgressMetric {
  const featureUnits = phase.features.length;
  const requiredDeliverables = phase.deliverables.filter((item) => item.required);
  const total = featureUnits + requiredDeliverables.length;

  const featureDone = phase.features.filter((feature) => feature.status === "completed").length;
  const deliverableDone = requiredDeliverables.filter((item) => item.status === "accepted").length;
  const completed = featureDone + deliverableDone;

  return metric(
    completed,
    total,
    "phases",
    total === 0
      ? "该阶段没有功能或必需交付物"
      : `功能 ${featureDone}/${featureUnits}，必需交付物 ${deliverableDone}/${requiredDeliverables.length}`,
  );
}

export function calculateMilestoneProgress(milestones: MilestoneProgressInput[]): ProgressMetric {
  const completed = milestones.filter((item) => item.completed).length;
  return metric(
    completed,
    milestones.length,
    "milestones",
    milestones.length === 0 ? "暂无里程碑" : "已完成里程碑 / 全部里程碑",
  );
}

function phaseMetrics(phases: PhaseProgressInput[]): ProgressMetric[] {
  return phases.map((phase) => calculatePhaseProgress(phase));
}

export function calculateProjectProgress(input: ProjectProgressInput): ProgressSnapshot {
  const tasks = calculateTaskProgress(input.tasks);
  const milestones = calculateMilestoneProgress(input.milestones);
  const perPhase = phaseMetrics(input.phases);

  const counted = input.phases
    .map((phase, index) => ({ phase, metric: perPhase[index] }))
    .filter(({ phase, metric }) => phase.countsTowardOverall !== false && metric.percent !== null);

  const phaseAverage =
    counted.length > 0
      ? Math.round((counted.reduce((sum, item) => sum + (item.metric.percent as number), 0) / counted.length) * 10) / 10
      : null;

  const fullyComplete = counted.filter((item) => item.metric.percent === 100).length;

  const phases = metric(
    fullyComplete,
    counted.length,
    "phases",
    counted.length === 0 ? "没有可计算的阶段进度" : "已全部完成的阶段 / 已定义阶段",
  );

  let overall: ProgressMetric;
  if (phaseAverage !== null) {
    overall = metric(
      fullyComplete,
      counted.length,
      "overall",
      `各阶段内部完成率算术平均（${counted.length} 个阶段）`,
    );
    overall.percent = phaseAverage;
  } else if (tasks.percent !== null) {
    overall = metric(tasks.completed, tasks.total, "overall", "无阶段数据，回退任务完成率");
    overall.percent = tasks.percent;
  } else {
    overall = metric(0, 0, "overall", "暂无可计算数据");
  }

  return {
    tasks,
    phases,
    milestones,
    overall,
    computedAt: input.computedAt ?? new Date().toISOString(),
  };
}

export function pendingTasks(tasks: TaskProgressInput[]): TaskProgressInput[] {
  return tasks.filter((task) => task.status === "pending");
}
