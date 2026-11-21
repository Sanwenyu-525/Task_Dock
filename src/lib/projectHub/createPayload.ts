/**
 * 草案 → 创建请求载荷（唯一转换点）。
 *
 * 硬规则（`docs/project-hub/07-迭代计划.md` S5 / v87 收口）：
 * - 阶段归属用 `phases` 数组下标；**未分配阶段必须是 `null`**，
 *   禁止把 `findIndex` 的 `-1` 当哨兵传给后端（会被 serde 拒绝或错配）；
 * - 能力需求同样携带阶段归属，创建后能在数据库里查到真实 `phase_id`；
 * - 只映射**会持久化**的字段：约束 / 风险 / 不确定项 / 工作空间建议不在这里出现，
 *   UI 必须显式说明它们不会被保存；
 * - 载荷是 `requestSignature` 的唯一输入，任何影响持久化结果的字段都必须出现在这里，
 *   否则「改了参数却复用旧请求 ID」会导致幂等键错配。
 */

import type { ProjectHubCreateInput } from "../../lib/contracts/models";
import type { ProjectDraft, ProjectKind } from "./types";

export type ProjectCreatePayload = Omit<ProjectHubCreateInput, "clientRequestId">;

function phaseIndexOf(phases: ProjectDraft["phases"], phaseId: string | null): number | null {
  if (!phaseId) return null;
  const index = phases.findIndex((phase) => phase.id === phaseId);
  return index >= 0 ? index : null;
}

/** 草案（模板 / 自然语言）→ 创建载荷。 */
export function buildCreatePayload(draft: ProjectDraft): ProjectCreatePayload {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    description: draft.description,
    goal: draft.goal,
    targetDate: draft.targetDate,
    templateId: draft.templateId,
    goals: draft.goal ? [{ title: draft.goal }] : [],
    phases: draft.phases.map((phase) => ({
      name: phase.title,
      description: phase.purpose,
      targetDate: phase.targetDate,
      startDate: phase.startDate,
      milestones: phase.milestoneTitles.map((name) => ({ name })),
    })),
    features: draft.phases.flatMap((phase) => {
      const phaseIndex = phaseIndexOf(draft.phases, phase.id);
      return phase.features.map((feature) => ({
        title: feature.title,
        acceptance: feature.acceptance,
        priority: feature.priority,
        phaseIndex,
      }));
    }),
    tasks: draft.tasks.map((task) => ({
      title: task.title,
      description: "",
      phaseIndex: phaseIndexOf(draft.phases, task.phaseId),
      dueAt: task.dueDate,
      priority: task.priority === "P0" ? 0 : task.priority === "P1" ? 1 : 3,
    })),
    capabilities: draft.capabilityRequirements.map((capability) => ({
      name: capability.name,
      category: capability.category,
      necessity: capability.necessity,
      targetLevel: capability.targetLevel,
      impact: capability.impact,
      alternative: capability.alternative,
      phaseIndex: phaseIndexOf(draft.phases, capability.phaseId),
    })),
  };
}

/** 手动创建（高级）→ 创建载荷：不生成任何阶段/功能/任务/能力。 */
export function buildManualCreatePayload(input: {
  name: string;
  kind: ProjectKind;
  goal?: string;
}): ProjectCreatePayload {
  const goal = input.goal?.trim() ?? "";
  return {
    name: input.name.trim(),
    kind: input.kind,
    goal,
    phases: [],
    features: [],
    tasks: [],
    capabilities: [],
    goals: goal ? [{ title: goal }] : [],
  };
}
