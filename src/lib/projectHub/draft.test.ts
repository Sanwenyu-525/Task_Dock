import { describe, expect, it } from "vitest";

import { createManualDraft, generateProjectDraft, preserveManualOverrides } from "./draft";
import { parseProjectIntent } from "./intent";

describe("generateProjectDraft", () => {
  it("小说草案包含七阶段、能力需求与初始任务", () => {
    const intent = parseProjectIntent("我要写一本30万字的科幻小说，三个月内完成");
    const draft = generateProjectDraft(intent);

    expect(draft.kind).toBe("novel");
    expect(draft.phases).toHaveLength(7);
    expect(draft.phases[0].title).toBe("世界观");
    expect(draft.capabilityRequirements.length).toBeGreaterThan(0);
    expect(draft.tasks).toHaveLength(2);
  });

  it("相对期限不转换成具体日期", () => {
    const draft = generateProjectDraft(parseProjectIntent("开发一个桌面应用，三个月内完成"));
    expect(draft.targetDate).toBeNull();
    expect(draft.constraints.some((item) => item.kind === "deadline" && item.relativeDays === 90)).toBe(true);
  });

  it("用户明确给出绝对日期时才写入 targetDate", () => {
    const draft = generateProjectDraft(parseProjectIntent("开发一个桌面应用，2026-12-31 完成"));
    expect(draft.targetDate).toBe("2026-12-31");
  });

  it("能力需求挂到引用它的首个阶段", () => {
    const draft = generateProjectDraft(parseProjectIntent("我要写一本小说"));
    const requirement = draft.capabilityRequirements.find((item) => item.key === "novel.worldbuilding");
    expect(requirement?.phaseId).toBe("phase-1");
  });

  it("初始任务按模板阶段映射 phaseId", () => {
    const draft = generateProjectDraft(parseProjectIntent("我要开发一款游戏"));
    const task = draft.tasks.find((item) => item.title === "搭一个可运行的空工程");
    expect(task?.phaseId).toBe("phase-3");
  });

  it("通用模板不虚构能力需求", () => {
    const draft = generateProjectDraft(parseProjectIntent("我要整理个人知识库"));
    expect(draft.phases).toHaveLength(4);
    expect(draft.capabilityRequirements).toHaveLength(0);
  });

  it("用户显式命名优先于推断标题", () => {
    const draft = generateProjectDraft(parseProjectIntent("我要写一本小说"), { name: "星海日志" });
    expect(draft.name).toBe("星海日志");
  });
});

describe("createManualDraft", () => {
  it("手动创建不生成阶段、日期或能力", () => {
    const draft = createManualDraft({ name: "我的项目", kind: "general" });
    expect(draft.phases).toHaveLength(0);
    expect(draft.targetDate).toBeNull();
    expect(draft.capabilityRequirements).toHaveLength(0);
    expect(draft.source).toBe("user");
  });
});

describe("preserveManualOverrides", () => {
  it("保留项目级手动字段", () => {
    const base = generateProjectDraft(parseProjectIntent("我要写一本小说"));
    base.name = "我的小说";
    base.manualFields = ["name"];

    const regenerated = generateProjectDraft(parseProjectIntent("我要写一本小说"));
    const merged = preserveManualOverrides(base, regenerated);
    expect(merged.name).toBe("我的小说");
  });

  it("保留阶段名称、日期与功能优先级", () => {
    const base = generateProjectDraft(parseProjectIntent("我要写一本小说"));
    base.phases[0].title = "自定义世界观";
    base.phases[0].startDate = "2026-12-01";
    base.phases[0].manualFields = ["title", "dates"];
    base.phases[0].features[0].priority = "P0";
    base.phases[0].features[0].manualFields = ["priority"];

    const merged = preserveManualOverrides(base, generateProjectDraft(parseProjectIntent("我要写一本小说")));

    expect(merged.phases[0].title).toBe("自定义世界观");
    expect(merged.phases[0].startDate).toBe("2026-12-01");
    expect(merged.phases[0].features[0].priority).toBe("P0");
  });

  it("保留用户新增的阶段与任务", () => {
    const base = generateProjectDraft(parseProjectIntent("我要写一本小说"));
    base.phases.push({
      id: "phase-user",
      title: "番外",
      purpose: "",
      order: 8,
      startDate: null,
      targetDate: null,
      features: [],
      milestoneTitles: [],
      capabilityKeys: [],
      source: "user",
      manualFields: ["title"],
    });
    base.tasks.push({
      id: "task-user",
      title: "写番外大纲",
      phaseId: "phase-user",
      priority: "P2",
      dueDate: null,
      capabilityKeys: [],
      source: "user",
      manualFields: ["title"],
    });

    const merged = preserveManualOverrides(base, generateProjectDraft(parseProjectIntent("我要写一本小说")));

    expect(merged.phases.some((phase) => phase.id === "phase-user")).toBe(true);
    expect(merged.tasks.some((task) => task.id === "task-user")).toBe(true);
  });

    it("不修改传入的既有草案", () => {
    const base = generateProjectDraft(parseProjectIntent("我要写一本小说"));
    base.name = "我的小说";
    base.manualFields = ["name"];
    const snapshot = JSON.stringify(base);

    preserveManualOverrides(base, generateProjectDraft(parseProjectIntent("我要写一本小说")));
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
