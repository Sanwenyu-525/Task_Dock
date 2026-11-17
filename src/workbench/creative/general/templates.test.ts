/**
 * 通用线模板常量矩阵测试（V1 收口验收，2026-11-17）。
 *
 * 纯函数/常量断言：六个模板的事项数、里程碑数、阶段标题、里程碑标题，
 * 以及非空白模板两两结构不同。后端落库对照见 `general_workspace.rs`
 * 的 `six_templates_produce_distinct_real_structures`。
 */
import { describe, expect, it } from "vitest";

import { GENERAL_TEMPLATES, templateCounts, type GeneralTemplate } from "./templates";

interface ExpectedTemplate {
  id: string;
  items: number;
  milestones: number;
  stageTitles: string[];
  milestoneTitles: string[];
}

const EXPECTED: ExpectedTemplate[] = [
  { id: "blank", items: 0, milestones: 0, stageTitles: [], milestoneTitles: [] },
  {
    id: "study-plan",
    items: 6,
    milestones: 3,
    stageTitles: ["目标梳理", "计划拆解", "学习执行"],
    milestoneTitles: ["目标确认", "计划就绪", "阶段验收"],
  },
  {
    id: "personal-plan",
    items: 5,
    milestones: 3,
    stageTitles: ["现状盘点", "计划制定", "跟进调整"],
    milestoneTitles: ["现状清晰", "计划落地", "阶段回顾"],
  },
  {
    id: "content-production",
    items: 7,
    milestones: 3,
    stageTitles: ["选题策划", "素材准备", "制作发布"],
    milestoneTitles: ["选题定稿", "素材就绪", "成品交付"],
  },
  {
    id: "event-planning",
    items: 7,
    milestones: 3,
    stageTitles: ["方案策划", "筹备落实", "执行复盘"],
    milestoneTitles: ["方案确认", "筹备就绪", "活动收官"],
  },
  {
    id: "research",
    items: 6,
    milestones: 3,
    stageTitles: ["问题界定", "方案设计", "分析总结"],
    milestoneTitles: ["问题界定", "方案成型", "成果交付"],
  },
];

function byId(id: string): GeneralTemplate {
  const found = GENERAL_TEMPLATES.find((t) => t.id === id);
  expect(found, `模板 ${id} 已注册`).toBeDefined();
  return found as GeneralTemplate;
}

describe("通用六模板结构矩阵", () => {
  it("模板数量与登记顺序一致", () => {
    expect(GENERAL_TEMPLATES).toHaveLength(EXPECTED.length);
    expect(GENERAL_TEMPLATES.map((t) => t.id)).toEqual(EXPECTED.map((e) => e.id));
  });

  for (const expected of EXPECTED) {
    it(`${expected.id} 事项/里程碑计数与阶段、里程碑标题一致`, () => {
      const template = byId(expected.id);
      const counts = templateCounts(template);
      expect(counts.items).toBe(expected.items);
      expect(counts.milestones).toBe(expected.milestones);
      expect(template.stages.map((s) => s.title)).toEqual(expected.stageTitles);
      expect(
        template.stages.filter((s) => s.milestone).map((s) => s.milestone!.title),
      ).toEqual(expected.milestoneTitles);
    });

    it(`${expected.id} 事项与里程碑标题均非空、模板内事项标题不重复`, () => {
      const template = byId(expected.id);
      const itemTitles = template.stages.flatMap((s) => s.items);
      for (const title of itemTitles) {
        expect(title.trim().length).toBeGreaterThan(0);
      }
      expect(new Set(itemTitles).size).toBe(itemTitles.length);
      for (const stage of template.stages) {
        if (stage.milestone) {
          expect(stage.milestone.title.trim().length).toBeGreaterThan(0);
        }
      }
    });
  }

  it("非空白模板两两事项集合与里程碑集合不同", () => {
    const nonBlank = EXPECTED.filter((e) => e.id !== "blank").map((e) => {
      const t = byId(e.id);
      return {
        id: e.id,
        items: new Set(t.stages.flatMap((s) => s.items)),
        milestones: new Set(
          t.stages.filter((s) => s.milestone).map((s) => s.milestone!.title),
        ),
      };
    });
    for (let i = 0; i < nonBlank.length; i += 1) {
      for (let j = i + 1; j < nonBlank.length; j += 1) {
        expect([...nonBlank[i].items]).not.toEqual([...nonBlank[j].items]);
        expect([...nonBlank[i].milestones]).not.toEqual([...nonBlank[j].milestones]);
      }
    }
  });
});
