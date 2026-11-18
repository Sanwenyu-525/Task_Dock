import { describe, expect, it } from "vitest";

import { cloneProjectDraft, generateProjectDraft } from "./draft";
import { parseProjectIntent } from "./intent";
import {
  generatePlanningDiff,
  reviseProjectDraft,
  rollbackPlanningRevision,
  validatePlanningRevision,
  type PlanVersionSnapshot,
} from "./revision";

function novelDraft() {
  return generateProjectDraft(parseProjectIntent("我要写一本30万字的科幻小说，三个月内完成"));
}

describe("reviseProjectDraft 局部修订", () => {
  it("只调整期限，不生成具体日期", () => {
    const base = novelDraft();
    const revision = reviseProjectDraft(base, "把开发周期调整到六个月");

    expect(revision.changed).toBe(true);
    const deadline = revision.draft.constraints.find((item) => item.kind === "deadline");
    expect(deadline?.relativeDays).toBe(180);
    expect(revision.draft.targetDate).toBeNull();
  });

  it("范围排除会移除相关功能，并保留手动字段", () => {
    const base = novelDraft();
    base.name = "我的小说";
    base.manualFields = ["name"];

    const revision = reviseProjectDraft(base, "先不要做章节");

    expect(revision.changed).toBe(true);
    expect(revision.draft.name).toBe("我的小说");
    const chapterPhase = revision.draft.phases.find((phase) => phase.title === "章节");
    expect(chapterPhase?.features).toHaveLength(0);
    expect(revision.draft.constraints.some((item) => item.kind === "scope" && item.value === "章节")).toBe(true);
  });

  it("阶段改名并标记手动字段", () => {
    const revision = reviseProjectDraft(novelDraft(), "把第二阶段改名为角色");
    expect(revision.changed).toBe(true);
    expect(revision.draft.phases[1].title).toBe("角色");
    expect(revision.draft.phases[1].manualFields).toContain("title");
  });

  it("新增阶段与新增功能", () => {
    const base = novelDraft();
    const revision = reviseProjectDraft(base, "增加一个测试阶段，在第二阶段增加一个功能：音效系统");

    expect(revision.changed).toBe(true);
    expect(revision.draft.phases).toHaveLength(8);
    expect(revision.draft.phases[7].title).toBe("测试");
    expect(revision.draft.phases[1].features.some((feature) => feature.title === "音效系统")).toBe(true);
  });

  it("无法识别的指令不改写草案，并给出原因", () => {
    const base = novelDraft();
    const revision = reviseProjectDraft(base, "让这个项目更好一点");

    expect(revision.changed).toBe(false);
    expect(revision.unparsedReason).toBeTruthy();
    expect(JSON.stringify(revision.draft)).toBe(JSON.stringify(base));
  });

  it("不修改传入的草案", () => {
    const base = novelDraft();
    const snapshot = JSON.stringify(base);
    reviseProjectDraft(base, "把开发周期调整到六个月");
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe("generatePlanningDiff", () => {
  it("识别删除阶段与受影响任务", () => {
    const before = novelDraft();
    const after = cloneProjectDraft(before);
    after.phases = after.phases.filter((phase) => phase.id !== "phase-1");

    const diff = generatePlanningDiff(before, after);
    const removedPhase = diff.removed.find((item) => item.entity === "phase" && item.targetId === "phase-1");
    expect(removedPhase?.affectedTaskIds).toContain("task-1");
    expect(diff.destructive.length).toBeGreaterThan(0);
  });

  it("识别项目级与功能级修改", () => {
    const before = novelDraft();
    const after = cloneProjectDraft(before);
    after.name = "改名后的项目";
    after.phases[0].features[0].priority = "P0";

    const diff = generatePlanningDiff(before, after);
    expect(diff.modified.some((item) => item.entity === "project" && item.after === "改名后的项目")).toBe(true);
    expect(diff.modified.some((item) => item.entity === "feature" && item.after === "P0")).toBe(true);
  });
});

describe("validatePlanningRevision", () => {
  it("删除已完成任务时阻止应用", () => {
    const before = novelDraft();
    const after = cloneProjectDraft(before);
    after.phases = after.phases.filter((phase) => phase.id !== "phase-1");

    const diff = generatePlanningDiff(before, after);
    const report = validatePlanningRevision(diff, { completedTaskIds: ["task-1"] });

    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "completed_task_removed" && issue.severity === "error")).toBe(true);
  });

  it("普通删除只给警告", () => {
    const before = novelDraft();
    const after = cloneProjectDraft(before);
    after.phases = after.phases.filter((phase) => phase.id !== "phase-1");

    const diff = generatePlanningDiff(before, after);
    const report = validatePlanningRevision(diff, { remainingPhaseCount: 6 });

    expect(report.ok).toBe(true);
    expect(report.issues.some((issue) => issue.code === "destructive_change")).toBe(true);
  });
});

describe("rollbackPlanningRevision", () => {
  it("返回快照副本", () => {
    const current = novelDraft();
    current.name = "当前版本";
    const snapshot = novelDraft();
    const version: PlanVersionSnapshot = {
      projectId: "p1",
      versionNo: 2,
      createdAt: "2026-11-18T00:00:00.000Z",
      snapshot,
    };

    const restored = rollbackPlanningRevision(current, version, "p1");
    expect(restored.name).toBe(snapshot.name);
    expect(restored).not.toBe(snapshot);
    expect(restored.phases).not.toBe(snapshot.phases);
  });

  it("拒绝其他项目的版本", () => {
    const version: PlanVersionSnapshot = {
      projectId: "p2",
      versionNo: 1,
      createdAt: "2026-11-18T00:00:00.000Z",
      snapshot: novelDraft(),
    };
    expect(() => rollbackPlanningRevision(novelDraft(), version, "p1")).toThrow("版本不属于当前项目");
  });
});
