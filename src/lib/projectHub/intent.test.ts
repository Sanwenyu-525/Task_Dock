import { describe, expect, it } from "vitest";

import {
  chineseToNumber,
  classifyProjectType,
  goalTitleFromText,
  parseAbsoluteDate,
  parseProjectIntent,
  parseRelativeDays,
  withProjectKind,
} from "./intent";

describe("中文数字与期限解析", () => {
  it("识别常见中文数字", () => {
    expect(chineseToNumber("三")).toBe(3);
    expect(chineseToNumber("两")).toBe(2);
    expect(chineseToNumber("十")).toBe(10);
    expect(chineseToNumber("十二")).toBe(12);
    expect(chineseToNumber("二十")).toBe(20);
    expect(chineseToNumber("二十三")).toBe(23);
    expect(chineseToNumber("半")).toBe(0.5);
    expect(chineseToNumber("abc")).toBeNull();
  });

  it("把相对期限换算成天数，不换算日期", () => {
    expect(parseRelativeDays("三个月内完成")).toBe(90);
    expect(parseRelativeDays("30 天")).toBe(30);
    expect(parseRelativeDays("两周")).toBe(14);
    expect(parseRelativeDays("半年")).toBe(183);
    expect(parseRelativeDays("没有期限")).toBeNull();
  });

  it("只接受合法绝对日期", () => {
    expect(parseAbsoluteDate("2026-12-31 完成")).toBe("2026-12-31");
    expect(parseAbsoluteDate("2026年3月5日")).toBe("2026-03-05");
    expect(parseAbsoluteDate("2026-02-30")).toBeNull();
    expect(parseAbsoluteDate("2026-13-01")).toBeNull();
  });
});

describe("目标标题", () => {
  it("去掉口头语、期限与尾部标点", () => {
    expect(goalTitleFromText("我要写一本30万字的科幻小说，三个月内完成。")).toBe("写一本30万字的科幻小说");
    expect(goalTitleFromText("我要在三个月内完成毕业设计")).toBe("毕业设计");
  });
});

describe("五种项目类型识别", () => {
  it.each([
    ["我要写一本30万字的科幻小说", "novel"],
    ["我要开发一款游戏", "game"],
    ["我要制作一部漫剧", "ai_comic"],
    ["我要整理个人知识库", "general"],
    ["我要开发一个桌面应用", "development"],
    ["我要在三个月内完成毕业设计", "general"],
  ] as const)("%s → %s", (input, expected) => {
    expect(parseProjectIntent(input).kind).toBe(expected);
  });

  it("无法判断时返回 null 并标记阻塞问题", () => {
    const intent = parseProjectIntent("帮我做点东西");
    expect(intent.kind).toBeNull();
    expect(intent.uncertainties.some((item) => item.field === "kind" && item.blocking)).toBe(true);
  });

  it("可以通过手动选择类型消除阻塞问题", () => {
    const intent = withProjectKind(parseProjectIntent("帮我做点东西"), "general");
    expect(intent.kind).toBe("general");
    expect(intent.uncertainties.some((item) => item.field === "kind")).toBe(false);
  });
});

describe("目标与约束提取", () => {
  it("提取字数额度与相对期限", () => {
    const intent = parseProjectIntent("我要写一本30万字的科幻小说，三个月内完成");
    expect(intent.kind).toBe("novel");
    expect(intent.goals).toHaveLength(1);
    expect(intent.goals[0].metric).toBe("字数");
    expect(intent.goals[0].targetValue).toBe(300000);
    expect(intent.constraints.some((item) => item.kind === "deadline" && item.relativeDays === 90)).toBe(true);
    expect(intent.uncertainties).toHaveLength(0);
  });

  it("没有说截止时间就不生成日期", () => {
    const intent = parseProjectIntent("我要整理个人知识库");
    const deadline = intent.constraints.find((item) => item.kind === "deadline");
    expect(deadline).toBeUndefined();
    expect(intent.uncertainties.some((item) => item.field === "targetDate" && !item.blocking)).toBe(true);
  });

  it("只提取用户明确说出的预算", () => {
    const intent = parseProjectIntent("做一个知识库，预算1万元");
    const budget = intent.constraints.find((item) => item.kind === "budget");
    expect(budget?.amount).toBe(10000);
    expect(budget?.currency).toBe("CNY");
  });

  it("未提及预算时不生成金额", () => {
    const intent = parseProjectIntent("做一个知识库");
    expect(intent.constraints.some((item) => item.kind === "budget")).toBe(false);
  });

  it("提取范围排除项与平台", () => {
    const intent = parseProjectIntent("做一个知识库，先不要做联机功能，只做 Windows 版");
    expect(intent.scopeNotes).toContain("联机");
    expect(intent.constraints.some((item) => item.kind === "platform" && item.value === "Windows")).toBe(true);
  });

  it("显式项目名称标记为用户提供", () => {
    const intent = parseProjectIntent("项目名称叫「星海日志」，写一本小说");
    expect(intent.title).toBe("星海日志");
    expect(intent.titleSource).toBe("user");
  });

  it("空输入不抛异常，返回可编辑的空意图", () => {
    const intent = parseProjectIntent("   ");
    expect(intent.goals).toHaveLength(0);
    expect(intent.title).toBeNull();
    expect(intent.uncertainties[0].blocking).toBe(true);
  });
});

describe("classifyProjectType", () => {
  it("已有类型直接返回，未识别时按原话判断", () => {
    const intent = parseProjectIntent("我要开发一款游戏");
    expect(classifyProjectType(intent)).toBe("game");
    expect(classifyProjectType({ ...intent, kind: null })).toBe("game");
  });
});
