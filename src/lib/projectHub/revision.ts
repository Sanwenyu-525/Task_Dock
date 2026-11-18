/**
 * 规划局部修订：只改受影响部分，保留手动修改；无法识别的指令不改写。
 *
 * 支持的自然语言形式（本地模式，不依赖 AI）：
 * - 期限：「把开发周期调整到六个月」
 * - 范围：「先不要做联机功能」
 * - 阶段：「删除第二阶段」「把第二阶段改名为核心玩法」「增加一个测试阶段」
 * - 功能：「在第二阶段增加一个功能：音效系统」
 * - 优先级：「把音效系统优先级改成 P1」
 *
 * 不支持的指令返回 `changed=false` + `unparsedReason`，不猜测、不重写整份草案。
 */

import { chineseToNumber, parseAbsoluteDate, parseRelativeDays } from "./intent";
import { cloneProjectDraft } from "./draft";
import type {
  CapabilityRequirementDraft,
  FeatureDraft,
  PhaseDraft,
  PlanChange,
  PlanningDiff,
  ProjectConstraint,
  ProjectDraft,
  ProjectDraftRevision,
  TaskDraft,
  ValidationIssue,
  ValidationReport,
} from "./types";

export interface PlanVersionSnapshot {
  projectId: string;
  versionNo: number;
  createdAt: string;
  snapshot: ProjectDraft;
}

export interface ValidationContext {
  /** 已存在的完成任务 ID；修订删除它们时必须报错。 */
  completedTaskIds?: string[];
  /** 修订后剩余阶段数；由调用方计算，用于「删光所有阶段」判断。 */
  remainingPhaseCount?: number;
}

const CLAUSE_SPLIT = /[，,；;]\s*/;

type ChangeInput = Omit<PlanChange, "before" | "after" | "affectedTaskIds" | "destructive"> &
  Partial<Pick<PlanChange, "before" | "after" | "affectedTaskIds" | "destructive">>;

function change(partial: ChangeInput): PlanChange {
  return {
    before: null,
    after: null,
    affectedTaskIds: [],
    destructive: false,
    ...partial,
  };
}

function phaseNumber(token: string): number | null {
  return chineseToNumber(token);
}

function constraintSummary(constraints: ProjectConstraint[]): string | null {
  const deadline = constraints.find((item) => item.kind === "deadline");
  if (!deadline) return null;
  if (deadline.absoluteDate) return `截止 ${deadline.absoluteDate}`;
  if (deadline.relativeDays !== null) return `约 ${deadline.relativeDays} 天`;
  return deadline.text;
}

function replaceDeadline(draft: ProjectDraft, clause: string): PlanChange | null {
  const relative = parseRelativeDays(clause);
  const absolute = parseAbsoluteDate(clause);
  if (relative === null && !absolute) return null;

  const before = constraintSummary(draft.constraints);
  const nextDeadline: ProjectConstraint = {
    kind: "deadline",
    text: clause,
    relativeDays: relative,
    absoluteDate: absolute,
    amount: null,
    currency: null,
    value: null,
    source: "user",
  };
  draft.constraints = draft.constraints.filter((item) => item.kind !== "deadline");
  draft.constraints.push(nextDeadline);
  if (absolute) draft.targetDate = absolute;

  return change({
    op: "modify",
    entity: "date",
    targetId: null,
    label: "调整期限",
    before,
    after: absolute ? `截止 ${absolute}` : `约 ${relative} 天`,
  });
}

function scopeKeyword(clause: string): string | null {
  const match =
    /(?:先|暂时)?(?:不要|不用|不做|不加|不含|不包括|不需要|去掉|砍掉|删掉)\s*(?:做|要|加|上)?\s*(.{1,20}?)(?:功能|模块|部分)?$/.exec(
      clause.trim(),
    );
  if (!match) return null;
  const keyword = match[1].trim().replace(/^的/, "").replace(/[的\s]+$/, "");
  return keyword || null;
}

function removeScope(draft: ProjectDraft, clause: string): { changes: PlanChange[]; reason: string | null } {
  const keyword = scopeKeyword(clause);
  if (!keyword) return { changes: [], reason: `无法识别范围调整：${clause}` };

  const changes: PlanChange[] = [];
  const affectedTaskIds: string[] = [];

  for (const phase of draft.phases) {
    const keptFeatures: FeatureDraft[] = [];
    for (const feature of phase.features) {
      if (feature.title.includes(keyword)) {
        changes.push(
          change({
            op: "remove",
            entity: "feature",
            targetId: feature.id,
            label: `移除功能「${feature.title}」`,
            before: feature.title,
            destructive: true,
          }),
        );
      } else {
        keptFeatures.push(feature);
      }
    }
    phase.features = keptFeatures;
  }

  const keptTasks: TaskDraft[] = [];
  for (const task of draft.tasks) {
    if (task.title.includes(keyword)) {
      affectedTaskIds.push(task.id);
      changes.push(
        change({
          op: "remove",
          entity: "task",
          targetId: task.id,
          label: `移除任务「${task.title}」`,
          before: task.title,
          destructive: true,
          affectedTaskIds: [task.id],
        }),
      );
    } else {
      keptTasks.push(task);
    }
  }
  draft.tasks = keptTasks;

  const keptCapabilities: CapabilityRequirementDraft[] = [];
  for (const requirement of draft.capabilityRequirements) {
    if (requirement.name.includes(keyword)) {
      changes.push(
        change({
          op: "remove",
          entity: "capability",
          targetId: requirement.key,
          label: `移除能力需求「${requirement.name}」`,
          before: requirement.name,
          destructive: false,
        }),
      );
    } else {
      keptCapabilities.push(requirement);
    }
  }
  draft.capabilityRequirements = keptCapabilities;

  for (const phase of draft.phases) {
    phase.capabilityKeys = phase.capabilityKeys.filter(
      (key) => draft.capabilityRequirements.some((requirement) => requirement.key === key),
    );
  }

  if (changes.length === 0) {
    return { changes: [], reason: `没有找到与「${keyword}」相关的功能、任务或能力` };
  }

  if (!draft.constraints.some((item) => item.kind === "scope" && item.value === keyword)) {
    draft.constraints.push({
      kind: "scope",
      text: clause,
      relativeDays: null,
      absoluteDate: null,
      amount: null,
      currency: null,
      value: keyword,
      source: "user",
    });
  }
  changes.push(
    change({
      op: "modify",
      entity: "scope",
      targetId: null,
      label: `范围排除「${keyword}」`,
      after: keyword,
      affectedTaskIds,
    }),
  );

  return { changes, reason: null };
}

function removePhase(draft: ProjectDraft, clause: string): { changes: PlanChange[]; reason: string | null } {
  const match = /(?:删除|去掉|移除)\s*(?:第)?\s*([一二三四五六七八九十\d]+)\s*(?:个)?\s*阶段/.exec(clause);
  if (!match) return { changes: [], reason: `无法识别阶段删除：${clause}` };
  const index = phaseNumber(match[1]);
  if (index === null || index < 1 || index > draft.phases.length) {
    return { changes: [], reason: `第 ${match[1]} 阶段不存在` };
  }
  const phase = draft.phases[index - 1];
  const affectedTaskIds = draft.tasks.filter((task) => task.phaseId === phase.id).map((task) => task.id);
  draft.phases = draft.phases.filter((item) => item.id !== phase.id);
  draft.tasks = draft.tasks.filter((task) => task.phaseId !== phase.id);

  const changes: PlanChange[] = [
    change({
      op: "remove",
      entity: "phase",
      targetId: phase.id,
      label: `删除阶段「${phase.title}」`,
      before: phase.title,
      destructive: phase.features.length > 0 || affectedTaskIds.length > 0,
      affectedTaskIds,
    }),
    ...phase.features.map((feature) =>
      change({
        op: "remove",
        entity: "feature",
        targetId: feature.id,
        label: `删除功能「${feature.title}」`,
        before: feature.title,
        destructive: false,
      }),
    ),
  ];

  for (const requirement of draft.capabilityRequirements) {
    if (requirement.phaseId === phase.id) requirement.phaseId = null;
  }
  draft.phases.forEach((item, order) => {
    item.order = order + 1;
  });

  return { changes, reason: null };
}

function renamePhase(draft: ProjectDraft, clause: string): { changes: PlanChange[]; reason: string | null } {
  const match = /(?:把|将)?\s*(?:第)?\s*([一二三四五六七八九十\d]+)\s*(?:个)?\s*阶段\s*(?:改名为|改名|改成|叫做|命名为)\s*(.+)$/.exec(
    clause,
  );
  if (!match) return { changes: [], reason: `无法识别阶段改名：${clause}` };
  const index = phaseNumber(match[1]);
  if (index === null || index < 1 || index > draft.phases.length) {
    return { changes: [], reason: `第 ${match[1]} 阶段不存在` };
  }
  const phase = draft.phases[index - 1];
  const nextTitle = match[2].trim().replace(/[。；;]+$/, "");
  if (!nextTitle) return { changes: [], reason: "新阶段名称为空" };
  const before = phase.title;
  phase.title = nextTitle;
  phase.manualFields = Array.from(new Set([...phase.manualFields, "title"]));
  return {
    changes: [
      change({
        op: "modify",
        entity: "phase",
        targetId: phase.id,
        label: `阶段改名：${before} → ${nextTitle}`,
        before,
        after: nextTitle,
      }),
    ],
    reason: null,
  };
}

function addPhase(draft: ProjectDraft, clause: string): { changes: PlanChange[]; reason: string | null } {
  const match = /(?:增加|添加|新增)\s*(?:一个|个)?\s*(.+?)\s*阶段/.exec(clause);
  if (!match) return { changes: [], reason: `无法识别新增阶段：${clause}` };
  const title = match[1].trim().replace(/[。；;]+$/, "");
  if (!title) return { changes: [], reason: "新阶段名称为空" };
  const nextId = `phase-${draft.phases.length + 1}`;
  draft.phases.push({
    id: nextId,
    title,
    purpose: "",
    order: draft.phases.length + 1,
    startDate: null,
    targetDate: null,
    features: [],
    milestoneTitles: [],
    capabilityKeys: [],
    source: "user",
    manualFields: ["title"],
  });
  return {
    changes: [
      change({
        op: "add",
        entity: "phase",
        targetId: nextId,
        label: `新增阶段「${title}」`,
        after: title,
      }),
    ],
    reason: null,
  };
}

function addFeature(draft: ProjectDraft, clause: string): { changes: PlanChange[]; reason: string | null } {
  const match =
    /(?:在)?\s*(?:第)?\s*([一二三四五六七八九十\d]+)\s*(?:个)?\s*阶段\s*(?:增加|添加|新增)\s*(?:一个|个)?\s*(?:功能|任务)?\s*(.+)$/.exec(
      clause,
    );
  if (!match) return { changes: [], reason: `无法识别新增功能：${clause}` };
  const index = phaseNumber(match[1]);
  if (index === null || index < 1 || index > draft.phases.length) {
    return { changes: [], reason: `第 ${match[1]} 阶段不存在` };
  }
  const title = match[2].trim().replace(/^[：:]\s*/, "").replace(/[。；;]+$/, "");
  if (!title) return { changes: [], reason: "新功能名称为空" };
  const phase = draft.phases[index - 1];
  const nextId = `feature-${index}-${phase.features.length + 1}`;
  phase.features.push({
    id: nextId,
    title,
    acceptance: "",
    priority: "P1",
    source: "user",
    manualFields: ["title"],
  });
  return {
    changes: [
      change({
        op: "add",
        entity: "feature",
        targetId: nextId,
        label: `在「${phase.title}」新增功能「${title}」`,
        after: title,
      }),
    ],
    reason: null,
  };
}

function setPriority(draft: ProjectDraft, clause: string): { changes: PlanChange[]; reason: string | null } {
  const match = /(?:把|将)?\s*(.+?)\s*(?:的)?优先级\s*(?:改成|设为|调整为)\s*(P0|P1|P2)/.exec(clause);
  if (!match) return { changes: [], reason: `无法识别优先级调整：${clause}` };
  const keyword = match[1].trim().replace(/^「|」$/g, "");
  const priority = match[2] as "P0" | "P1" | "P2";
  const features = draft.phases.flatMap((phase) => phase.features);
  const targets = features.filter((feature) => feature.title.includes(keyword));
  if (targets.length === 0) return { changes: [], reason: `没有找到功能「${keyword}」` };
  return {
    changes: targets.map((feature) => {
      const before = feature.priority;
      feature.priority = priority;
      feature.manualFields = Array.from(new Set([...feature.manualFields, "priority"]));
      return change({
        op: "modify",
        entity: "feature",
        targetId: feature.id,
        label: `「${feature.title}」优先级 ${before} → ${priority}`,
        before,
        after: priority,
      });
    }),
    reason: null,
  };
}

function applyClause(draft: ProjectDraft, clause: string): { changes: PlanChange[]; reason: string | null } {
  const trimmed = clause.trim();
  if (!trimmed) return { changes: [], reason: null };

  const deadline = replaceDeadline(draft, trimmed);
  if (deadline) return { changes: [deadline], reason: null };

  if (/阶段/.test(trimmed)) {
    if (/(?:删除|去掉|移除)/.test(trimmed)) return removePhase(draft, trimmed);
    if (/(?:改名|改名为|改成|叫做|命名为)/.test(trimmed)) return renamePhase(draft, trimmed);
    if (/(?:增加|添加|新增)/.test(trimmed) && /(?:功能|任务)/.test(trimmed)) return addFeature(draft, trimmed);
    if (/(?:增加|添加|新增)/.test(trimmed)) return addPhase(draft, trimmed);
  }

  if (/优先级/.test(trimmed)) return setPriority(draft, trimmed);
  if (/(?:不要|不用|不做|不加|不含|不包括|不需要|去掉|砍掉|删掉)/.test(trimmed)) {
    return removeScope(draft, trimmed);
  }

  return { changes: [], reason: `无法识别的指令：${trimmed}` };
}

/**
 * 局部修订：按标点拆成子句逐条应用；未识别子句只记录原因，不改写。
 */
export function reviseProjectDraft(draft: ProjectDraft, instruction: string): ProjectDraftRevision {
  const next = cloneProjectDraft(draft);
  const clauses = instruction
    .split(CLAUSE_SPLIT)
    .map((clause) => clause.trim())
    .filter(Boolean);

  const changes: PlanChange[] = [];
  const reasons: string[] = [];

  for (const clause of clauses) {
    const result = applyClause(next, clause);
    changes.push(...result.changes);
    if (result.reason) reasons.push(result.reason);
  }

  return {
    instruction,
    changed: changes.length > 0,
    draft: next,
    changes,
    unparsedReason: reasons.length > 0 ? reasons.join("；") : changes.length === 0 ? "没有识别到可执行的修改" : null,
  };
}

function findFeature(draft: ProjectDraft, featureId: string): { phase: PhaseDraft; feature: FeatureDraft } | null {
  for (const phase of draft.phases) {
    const feature = phase.features.find((item) => item.id === featureId);
    if (feature) return { phase, feature };
  }
  return null;
}

function findTask(draft: ProjectDraft, taskId: string): TaskDraft | null {
  return draft.tasks.find((item) => item.id === taskId) ?? null;
}

/**
 * 生成前后差异。用于预览；不落库。
 */
export function generatePlanningDiff(before: ProjectDraft, after: ProjectDraft): PlanningDiff {
  const added: PlanChange[] = [];
  const removed: PlanChange[] = [];
  const modified: PlanChange[] = [];

  if (before.name !== after.name) {
    modified.push(
      change({ op: "modify", entity: "project", targetId: null, label: "项目名称", before: before.name, after: after.name }),
    );
  }
  if (before.goal !== after.goal) {
    modified.push(
      change({ op: "modify", entity: "project", targetId: null, label: "项目目标", before: before.goal, after: after.goal }),
    );
  }
  if (before.targetDate !== after.targetDate) {
    modified.push(
      change({
        op: "modify",
        entity: "date",
        targetId: null,
        label: "项目截止日期",
        before: before.targetDate,
        after: after.targetDate,
      }),
    );
  }

  const beforePhases = new Map(before.phases.map((phase) => [phase.id, phase]));
  const afterPhases = new Map(after.phases.map((phase) => [phase.id, phase]));

  for (const [id, phase] of afterPhases) {
    const beforePhase = beforePhases.get(id);
    if (!beforePhase) {
      added.push(change({ op: "add", entity: "phase", targetId: id, label: `新增阶段「${phase.title}」`, after: phase.title }));
      continue;
    }
    if (beforePhase.title !== phase.title) {
      modified.push(
        change({ op: "modify", entity: "phase", targetId: id, label: "阶段名称", before: beforePhase.title, after: phase.title }),
      );
    }
    if (beforePhase.order !== phase.order) {
      modified.push(
        change({
          op: "move",
          entity: "phase",
          targetId: id,
          label: `阶段顺序 ${beforePhase.order} → ${phase.order}`,
          before: String(beforePhase.order),
          after: String(phase.order),
        }),
      );
    }
    if (beforePhase.startDate !== phase.startDate || beforePhase.targetDate !== phase.targetDate) {
      modified.push(
        change({
          op: "modify",
          entity: "date",
          targetId: id,
          label: `阶段「${phase.title}」日期`,
          before: `${beforePhase.startDate ?? "空"} ~ ${beforePhase.targetDate ?? "空"}`,
          after: `${phase.startDate ?? "空"} ~ ${phase.targetDate ?? "空"}`,
        }),
      );
    }
  }
  for (const [id, phase] of beforePhases) {
    if (!afterPhases.has(id)) {
      const affectedTaskIds = after.tasks.filter((task) => task.phaseId === id).map((task) => task.id);
      removed.push(
        change({
          op: "remove",
          entity: "phase",
          targetId: id,
          label: `删除阶段「${phase.title}」`,
          before: phase.title,
          destructive: phase.features.length > 0,
          affectedTaskIds,
        }),
      );
    }
  }

  // 功能（跨阶段按 id 比对，包含移动）
  const beforeFeatures = new Map<string, { phase: PhaseDraft; feature: FeatureDraft }>();
  for (const phase of before.phases) {
    for (const feature of phase.features) beforeFeatures.set(feature.id, { phase, feature });
  }
  const afterFeatures = new Map<string, { phase: PhaseDraft; feature: FeatureDraft }>();
  for (const phase of after.phases) {
    for (const feature of phase.features) afterFeatures.set(feature.id, { phase, feature });
  }

  for (const [id, entry] of afterFeatures) {
    const beforeEntry = beforeFeatures.get(id);
    if (!beforeEntry) {
      added.push(
        change({
          op: "add",
          entity: "feature",
          targetId: id,
          label: `新增功能「${entry.feature.title}」`,
          after: entry.feature.title,
        }),
      );
      continue;
    }
    if (beforeEntry.feature.title !== entry.feature.title) {
      modified.push(
        change({
          op: "modify",
          entity: "feature",
          targetId: id,
          label: "功能名称",
          before: beforeEntry.feature.title,
          after: entry.feature.title,
        }),
      );
    }
    if (beforeEntry.feature.priority !== entry.feature.priority) {
      modified.push(
        change({
          op: "modify",
          entity: "feature",
          targetId: id,
          label: `「${entry.feature.title}」优先级`,
          before: beforeEntry.feature.priority,
          after: entry.feature.priority,
        }),
      );
    }
    if (beforeEntry.phase.id !== entry.phase.id) {
      modified.push(
        change({
          op: "move",
          entity: "feature",
          targetId: id,
          label: `功能「${entry.feature.title}」所属阶段`,
          before: beforeEntry.phase.title,
          after: entry.phase.title,
        }),
      );
    }
  }
  for (const [id, entry] of beforeFeatures) {
    if (!afterFeatures.has(id)) {
      const affectedTaskIds = after.tasks.filter((task) => task.phaseId === entry.phase.id).map((task) => task.id);
      removed.push(
        change({
          op: "remove",
          entity: "feature",
          targetId: id,
          label: `删除功能「${entry.feature.title}」`,
          before: entry.feature.title,
          destructive: false,
          affectedTaskIds,
        }),
      );
    }
  }

  // 能力需求
  const beforeCapabilities = new Map(before.capabilityRequirements.map((item) => [item.key, item]));
  const afterCapabilities = new Map(after.capabilityRequirements.map((item) => [item.key, item]));
  for (const [key, requirement] of afterCapabilities) {
    const beforeRequirement = beforeCapabilities.get(key);
    if (!beforeRequirement) {
      added.push(
        change({ op: "add", entity: "capability", targetId: key, label: `新增能力需求「${requirement.name}」`, after: requirement.name }),
      );
    } else if (
      beforeRequirement.necessity !== requirement.necessity ||
      beforeRequirement.phaseId !== requirement.phaseId ||
      beforeRequirement.targetLevel !== requirement.targetLevel
    ) {
      modified.push(
        change({
          op: "modify",
          entity: "capability",
          targetId: key,
          label: `能力需求「${requirement.name}」`,
          before: `${beforeRequirement.necessity}/${beforeRequirement.phaseId ?? "无阶段"}`,
          after: `${requirement.necessity}/${requirement.phaseId ?? "无阶段"}`,
        }),
      );
    }
  }
  for (const [key, requirement] of beforeCapabilities) {
    if (!afterCapabilities.has(key)) {
      removed.push(
        change({
          op: "remove",
          entity: "capability",
          targetId: key,
          label: `移除能力需求「${requirement.name}」`,
          before: requirement.name,
          destructive: false,
        }),
      );
    }
  }

  // 任务
  const beforeTasks = new Map(before.tasks.map((task) => [task.id, task]));
  const afterTasks = new Map(after.tasks.map((task) => [task.id, task]));
  for (const [id, task] of afterTasks) {
    const beforeTask = beforeTasks.get(id);
    if (!beforeTask) {
      added.push(change({ op: "add", entity: "task", targetId: id, label: `新增任务「${task.title}」`, after: task.title }));
    } else if (beforeTask.title !== task.title || beforeTask.phaseId !== task.phaseId) {
      modified.push(
        change({
          op: "modify",
          entity: "task",
          targetId: id,
          label: `任务「${task.title}」`,
          before: beforeTask.title,
          after: task.title,
        }),
      );
    }
  }
  for (const [id, task] of beforeTasks) {
    if (!afterTasks.has(id)) {
      removed.push(
        change({
          op: "remove",
          entity: "task",
          targetId: id,
          label: `移除任务「${task.title}」`,
          before: task.title,
          destructive: true,
          affectedTaskIds: [id],
        }),
      );
    }
  }

  const destructive = [...added, ...removed, ...modified].filter((item) => item.destructive);

  const preservedManualFields: string[] = [];
  if (after.manualFields.length > 0) preservedManualFields.push(...after.manualFields.map((field) => `project.${field}`));
  for (const phase of after.phases) {
    for (const field of phase.manualFields) preservedManualFields.push(`${phase.id}.${field}`);
    for (const feature of phase.features) {
      for (const field of feature.manualFields) preservedManualFields.push(`${feature.id}.${field}`);
    }
  }

  return { added, removed, modified, destructive, preservedManualFields };
}

/**
 * 校验修订：错误阻止应用，警告需用户确认。
 */
export function validatePlanningRevision(diff: PlanningDiff, context: ValidationContext = {}): ValidationReport {
  const issues: ValidationIssue[] = [];
  const completedTaskIds = new Set(context.completedTaskIds ?? []);

  for (const item of diff.removed) {
    const hitCompleted = item.affectedTaskIds.filter((id) => completedTaskIds.has(id));
    if (hitCompleted.length > 0) {
      issues.push({
        code: "completed_task_removed",
        severity: "error",
        message: `修订会删除已完成任务：${hitCompleted.join(", ")}`,
        targetId: item.targetId,
      });
    }
  }

  for (const item of diff.destructive) {
    if (item.entity === "task" || item.entity === "phase") {
      issues.push({
        code: "destructive_change",
        severity: "warning",
        message: `「${item.label}」会删除执行内容，需确认`,
        targetId: item.targetId,
      });
    }
  }

  if (context.remainingPhaseCount === 0) {
    issues.push({
      code: "no_phases",
      severity: "warning",
      message: "修订后没有任何阶段，项目将无法计算阶段进度",
      targetId: null,
    });
  }

  const phaseTitles = new Set<string>();
  for (const item of diff.added) {
    if (item.entity === "phase" && item.after) {
      if (phaseTitles.has(item.after)) {
        issues.push({
          code: "duplicate_phase_title",
          severity: "warning",
          message: `新增阶段重名：${item.after}`,
          targetId: item.targetId,
        });
      }
      phaseTitles.add(item.after);
    }
  }

  return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

/**
 * 回滚到历史版本：返回快照副本。
 * 调用方必须校验 `version.projectId` 与当前项目一致；回滚不重新套用手动修改。
 */
export function rollbackPlanningRevision(
  _current: ProjectDraft,
  version: PlanVersionSnapshot,
  expectedProjectId?: string,
): ProjectDraft {
  if (expectedProjectId && version.projectId !== expectedProjectId) {
    throw new Error("版本不属于当前项目");
  }
  if (!version.snapshot || !Array.isArray(version.snapshot.phases)) {
    throw new Error("版本快照结构无效");
  }
  return cloneProjectDraft(version.snapshot);
}

export { findFeature, findTask };
