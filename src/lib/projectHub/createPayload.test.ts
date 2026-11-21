/**
 * 创建载荷契约测试（v87）：
 * - 未分配阶段必须是 `null`，不能是 `-1`（后端 `Option<usize>` 不接受哨兵值）；
 * - 能力需求携带阶段归属，且阶段下标与 phases 数组一致；
 * - 载荷覆盖所有影响持久化结果的字段（requestSignature 才有意义）。
 */

import { describe, expect, it } from "vitest";
import { buildCreatePayload, buildManualCreatePayload } from "./createPayload";
import { createManualDraft } from "./draft";
import { requestSignature } from "./requestId";
import type { ProjectDraft } from "./types";

function draft(overrides: Partial<ProjectDraft> = {}): ProjectDraft {
  return {
    name: "示例项目",
    kind: "general",
    goal: "完成目标",
    description: "描述",
    targetDate: null,
    phases: [
      {
        id: "phase-1",
        title: "阶段一",
        purpose: "目标一",
        order: 1,
        startDate: null,
        targetDate: null,
        features: [
          {
            id: "feature-1",
            title: "功能一",
            acceptance: "可验收",
            priority: "P1",
            source: "user",
            manualFields: [],
          },
        ],
        milestoneTitles: ["里程碑一"],
        capabilityKeys: ["cap-1"],
        source: "user",
        manualFields: [],
      },
    ],
    capabilityRequirements: [
      {
        key: "cap-1",
        name: "能力一",
        category: "human",
        necessity: "required",
        targetLevel: "basic",
        phaseId: "phase-1",
        impact: "",
        alternative: "",
        source: "user",
      },
      {
        key: "cap-2",
        name: "能力二",
        category: "tool",
        necessity: "optional",
        targetLevel: "basic",
        phaseId: null,
        impact: "",
        alternative: "",
        source: "user",
      },
    ],
    tasks: [
      {
        id: "task-1",
        title: "有阶段任务",
        phaseId: "phase-1",
        priority: "P1",
        dueDate: null,
        capabilityKeys: [],
        source: "user",
        manualFields: [],
      },
      {
        id: "task-2",
        title: "未分阶段任务",
        phaseId: null,
        priority: "P2",
        dueDate: null,
        capabilityKeys: [],
        source: "user",
        manualFields: [],
      },
    ],
    constraints: [],
    workspace: { rootPathHint: null, moduleHints: [], note: "" },
    risks: [],
    uncertainties: [],
    templateId: "",
    source: "user",
    manualFields: [],
    ...overrides,
  };
}

describe("草案 → 创建载荷", () => {
  it("未分配阶段的任务与能力传 null，不传 -1", () => {
    const payload = buildCreatePayload(draft());
    expect(payload.tasks?.[0].phaseIndex).toBe(0);
    expect(payload.tasks?.[1].phaseIndex).toBeNull();
    expect(payload.capabilities?.[0].phaseIndex).toBe(0);
    expect(payload.capabilities?.[1].phaseIndex).toBeNull();
    for (const item of [...(payload.tasks ?? []), ...(payload.capabilities ?? []), ...(payload.features ?? [])]) {
      expect(item.phaseIndex).not.toBe(-1);
    }
  });

  it("阶段下标与 phases 数组一致（多阶段不乱序）", () => {
    const base = draft();
    const second = {
      ...base.phases[0],
      id: "phase-2",
      title: "阶段二",
      order: 2,
      features: [],
      capabilityKeys: [],
    };
    const payload = buildCreatePayload({
      ...base,
      phases: [base.phases[0], second],
      tasks: [
        { ...base.tasks[0], id: "t2", phaseId: "phase-2" },
        { ...base.tasks[0], id: "t3", phaseId: "missing" },
      ],
    });
    expect(payload.tasks?.[0].phaseIndex).toBe(1);
    expect(payload.tasks?.[1].phaseIndex).toBeNull();
  });

  it("请求签名覆盖阶段归属：改了阶段就是另一个请求", () => {
    const base = draft();
    const moved = draft({
      tasks: [{ ...base.tasks[1], phaseId: "phase-1" }],
    });
    expect(requestSignature(buildCreatePayload(base) as Record<string, unknown>)).not.toBe(
      requestSignature(buildCreatePayload(moved) as Record<string, unknown>),
    );
  });

  it("手动创建不生成阶段/功能/任务/能力，也不带未保存字段", () => {
    const manual = createManualDraft({ name: "手动项目", kind: "general", goal: "目标" });
    const payload = buildManualCreatePayload({ name: manual.name, kind: manual.kind, goal: manual.goal });
    expect(payload.phases).toEqual([]);
    expect(payload.features).toEqual([]);
    expect(payload.tasks).toEqual([]);
    expect(payload.capabilities).toEqual([]);
    expect(payload.goals).toEqual([{ title: "目标" }]);
    // 约束/风险/工作空间建议不属于持久化字段。
    expect("constraints" in payload).toBe(false);
    expect("risks" in payload).toBe(false);
    expect("workspace" in payload).toBe(false);
  });
});
