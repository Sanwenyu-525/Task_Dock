/**
 * 草案生成与手动覆盖保留。
 *
 * 硬规则：
 * - 没有显式日期 → `targetDate = null`（相对期限留在 constraints）；
 * - 模板只给默认值，所有条目可编辑；
 * - `preserveManualOverrides` 必须保留用户改过的字段与条目，不允许生成结果整体覆盖。
 */

import { templateFor, KIND_LABELS, type ProjectTemplate } from "./templates";
import { projectNameFromText } from "./intent";
import type {
  CapabilityRequirementDraft,
  FieldSource,
  PhaseDraft,
  ProjectConstraint,
  ProjectDraft,
  ProjectIntent,
  ProjectKind,
  TaskDraft,
} from "./types";

export interface GenerateDraftOptions {
  /** 用户手动选择的模板；未提供时使用意图类型。 */
  templateId?: ProjectKind;
  /** 用户手动输入的名称（优先级最高）。 */
  name?: string;
}

function clonePhase(phase: PhaseDraft): PhaseDraft {
  return {
    ...phase,
    features: phase.features.map((feature) => ({ ...feature, manualFields: [...feature.manualFields] })),
    milestoneTitles: [...phase.milestoneTitles],
    capabilityKeys: [...phase.capabilityKeys],
    manualFields: [...phase.manualFields],
  };
}

function cloneDraft(draft: ProjectDraft): ProjectDraft {
  return {
    ...draft,
    phases: draft.phases.map(clonePhase),
    capabilityRequirements: draft.capabilityRequirements.map((requirement) => ({ ...requirement })),
    tasks: draft.tasks.map((task) => ({
      ...task,
      capabilityKeys: [...task.capabilityKeys],
      manualFields: [...task.manualFields],
    })),
    constraints: draft.constraints.map((constraint) => ({ ...constraint })),
    workspace: { ...draft.workspace, moduleHints: [...draft.workspace.moduleHints] },
    risks: [...draft.risks],
    uncertainties: draft.uncertainties.map((uncertainty) => ({ ...uncertainty, options: [...uncertainty.options] })),
    manualFields: [...draft.manualFields],
  };
}

export function cloneProjectDraft(draft: ProjectDraft): ProjectDraft {
  return cloneDraft(draft);
}

function firstAbsoluteDate(constraints: ProjectConstraint[]): string | null {
  const deadline = constraints.find(
    (constraint) => constraint.kind === "deadline" && constraint.absoluteDate !== null,
  );
  return deadline?.absoluteDate ?? null;
}

function buildPhases(template: ProjectTemplate): PhaseDraft[] {
  return template.phases.map((phase, phaseIndex) => ({
    id: `phase-${phaseIndex + 1}`,
    title: phase.title,
    purpose: phase.purpose,
    order: phaseIndex + 1,
    startDate: null,
    targetDate: null,
    features: phase.features.map((feature, featureIndex) => ({
      id: `feature-${phaseIndex + 1}-${featureIndex + 1}`,
      title: feature.title,
      acceptance: feature.acceptance,
      priority: "P1" as const,
      source: "template" as FieldSource,
      manualFields: [],
    })),
    milestoneTitles: [phase.milestone],
    capabilityKeys: [...phase.capabilityKeys],
    source: "template" as FieldSource,
    manualFields: [],
  }));
}

function buildCapabilityRequirements(template: ProjectTemplate, phases: PhaseDraft[]): CapabilityRequirementDraft[] {
  return template.capabilities.map((capability) => {
    const phase = phases.find((item) => item.capabilityKeys.includes(capability.key)) ?? null;
    return {
      key: capability.key,
      name: capability.name,
      category: capability.category,
      necessity: capability.necessity,
      targetLevel: capability.targetLevel,
      phaseId: phase ? phase.id : null,
      impact: capability.impact,
      alternative: capability.alternative,
      source: "template" as FieldSource,
    };
  });
}

function buildTasks(template: ProjectTemplate, phases: PhaseDraft[]): TaskDraft[] {
  return template.initialTasks.map((task, index) => {
    const phase = phases.find((item) => item.title === template.phases.find((p) => p.key === task.phaseKey)?.title);
    return {
      id: `task-${index + 1}`,
      title: task.title,
      phaseId: phase ? phase.id : null,
      priority: task.priority,
      dueDate: null,
      capabilityKeys: [...task.capabilityKeys],
      source: "template" as FieldSource,
      manualFields: [],
    };
  });
}

/**
 * 生成项目草案。纯函数，不写数据库、不生成日期。
 */
export function generateProjectDraft(
  intent: ProjectIntent,
  options: GenerateDraftOptions = {},
): ProjectDraft {
  const kind: ProjectKind = intent.kind ?? options.templateId ?? "general";
  const template = templateFor(kind);
  const phases = buildPhases(template);
  const targetDate = firstAbsoluteDate(intent.constraints);

  const explicitName =
    options.name?.trim() ||
    (intent.titleSource === "user" ? intent.title?.trim() : "") ||
    projectNameFromText(intent.raw) ||
    "";
  const name = explicitName || `${KIND_LABELS[kind]}项目`;

  return {
    name,
    kind,
    goal: intent.goals[0]?.title ?? "",
    description: intent.raw,
    targetDate,
    phases,
    capabilityRequirements: buildCapabilityRequirements(template, phases),
    tasks: buildTasks(template, phases),
    constraints: intent.constraints.map((constraint) => ({ ...constraint })),
    workspace: {
      rootPathHint: null,
      moduleHints: [...template.workspaceModules],
      note: "建议在工作空间中登记项目根目录；未提供路径时不自动创建。",
    },
    risks: [],
    uncertainties: intent.uncertainties.map((uncertainty) => ({
      ...uncertainty,
      options: [...uncertainty.options],
    })),
    templateId: template.id,
    source: "template",
    manualFields: [],
  };
}

/** 手动创建（高级）时的最小草案：不生成阶段，不猜测任何事实。 */
export function createManualDraft(input: {
  name: string;
  kind: ProjectKind;
  goal?: string;
  description?: string;
}): ProjectDraft {
  const name = input.name.trim();
  return {
    name,
    kind: input.kind,
    goal: input.goal?.trim() ?? "",
    description: input.description?.trim() ?? "",
    targetDate: null,
    phases: [],
    capabilityRequirements: [],
    tasks: [],
    constraints: [],
    workspace: {
      rootPathHint: null,
      moduleHints: [...templateFor(input.kind).workspaceModules],
      note: "",
    },
    risks: [],
    uncertainties: [],
    templateId: "",
    source: "user",
    manualFields: ["name", "goal", "description", "targetDate"],
  };
}

const PROJECT_MANUAL_FIELDS = new Set(["name", "goal", "description", "targetDate"]);

function mergeManualFields(existing: string[], generated: string[]): string[] {
  return Array.from(new Set([...existing, ...generated]));
}

/**
 * 保留用户手动修改：生成结果与既有草案合并。
 *
 * - 项目级：`manualFields` 中的字段保留既有值；
 * - 阶段级：按 id 合并；`manualFields` 含 `title/dates/features/capabilityKeys` 时整项保留；
 * - 功能级：按 id 合并；手工新增或手工修改的条目保留；
 * - 能力需求：`source=user` 的条目保留；
 * - 任务：手工修改的条目保留；
 * - 既有手工条目在生成结果中缺失时追加，而不是删除。
 */
export function preserveManualOverrides(existing: ProjectDraft, generated: ProjectDraft): ProjectDraft {
  const merged = cloneDraft(generated);

  for (const field of PROJECT_MANUAL_FIELDS) {
    if (existing.manualFields.includes(field)) {
      switch (field) {
        case "name":
          merged.name = existing.name;
          break;
        case "goal":
          merged.goal = existing.goal;
          break;
        case "description":
          merged.description = existing.description;
          break;
        case "targetDate":
          merged.targetDate = existing.targetDate;
          break;
        default:
          break;
      }
    }
  }
  merged.manualFields = mergeManualFields(existing.manualFields, merged.manualFields);

  // 阶段合并
  for (const existingPhase of existing.phases) {
    const target = merged.phases.find((phase) => phase.id === existingPhase.id);
    if (!target) {
      if (existingPhase.manualFields.length > 0 || existingPhase.source === "user") {
        merged.phases.push(clonePhase(existingPhase));
      }
      continue;
    }

    if (existingPhase.manualFields.includes("title")) target.title = existingPhase.title;
    if (existingPhase.manualFields.includes("purpose")) target.purpose = existingPhase.purpose;
    if (existingPhase.manualFields.includes("dates")) {
      target.startDate = existingPhase.startDate;
      target.targetDate = existingPhase.targetDate;
    }
    if (existingPhase.manualFields.includes("milestones")) {
      target.milestoneTitles = [...existingPhase.milestoneTitles];
    }
    if (existingPhase.manualFields.includes("capabilityKeys")) {
      target.capabilityKeys = [...existingPhase.capabilityKeys];
    }

    if (existingPhase.manualFields.includes("features")) {
      target.features = existingPhase.features.map((feature) => ({
        ...feature,
        manualFields: [...feature.manualFields],
      }));
    } else {
      for (const existingFeature of existingPhase.features) {
        const targetFeature = target.features.find((feature) => feature.id === existingFeature.id);
        if (!targetFeature) {
          if (existingFeature.manualFields.length > 0 || existingFeature.source === "user") {
            target.features.push({ ...existingFeature, manualFields: [...existingFeature.manualFields] });
          }
          continue;
        }
        for (const field of existingFeature.manualFields) {
          if (field === "title") targetFeature.title = existingFeature.title;
          if (field === "acceptance") targetFeature.acceptance = existingFeature.acceptance;
          if (field === "priority") targetFeature.priority = existingFeature.priority;
        }
      }
    }

    target.manualFields = mergeManualFields(existingPhase.manualFields, target.manualFields);
  }

  // 能力需求：用户手动维护的保留
  for (const requirement of existing.capabilityRequirements) {
    const target = merged.capabilityRequirements.find((item) => item.key === requirement.key);
    if (target) {
      if (requirement.source === "user") {
        target.name = requirement.name;
        target.category = requirement.category;
        target.necessity = requirement.necessity;
        target.targetLevel = requirement.targetLevel;
        target.phaseId = requirement.phaseId;
        target.impact = requirement.impact;
        target.alternative = requirement.alternative;
        target.source = "user";
      }
    } else if (requirement.source === "user") {
      merged.capabilityRequirements.push({ ...requirement });
    }
  }

  // 任务：手工改过的保留
  for (const task of existing.tasks) {
    const target = merged.tasks.find((item) => item.id === task.id);
    if (!target) {
      if (task.manualFields.length > 0 || task.source === "user") {
        merged.tasks.push({ ...task, capabilityKeys: [...task.capabilityKeys], manualFields: [...task.manualFields] });
      }
      continue;
    }
    for (const field of task.manualFields) {
      if (field === "title") target.title = task.title;
      if (field === "priority") target.priority = task.priority;
      if (field === "dueDate") target.dueDate = task.dueDate;
      if (field === "phaseId") target.phaseId = task.phaseId;
    }
    target.manualFields = mergeManualFields(task.manualFields, target.manualFields);
  }

  return merged;
}
