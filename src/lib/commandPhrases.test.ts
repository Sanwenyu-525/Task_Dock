//! 句式命令前端启发式单测：路由判定、行数与提示映射（不替代后端帧表）。

import { describe, expect, it } from "vitest";

import {
  looksLikePhrase,
  phraseHints,
  phraseRowCount,
  priorityLabelKey,
} from "./commandPhrases";

describe("looksLikePhrase", () => {
  it("识别帧表起手词与关键词", () => {
    expect(looksLikePhrase("完成 交周报")).toBe(true);
    expect(looksLikePhrase("把交周报改到明天")).toBe(true);
    expect(looksLikePhrase("本周完成了什么")).toBe(true);
    expect(looksLikePhrase("有哪些逾期的")).toBe(true);
    expect(looksLikePhrase("逾期任务")).toBe(true);
    expect(looksLikePhrase("今天要做什么")).toBe(true);
    expect(looksLikePhrase("哪些 Agent 失败了")).toBe(true);
    expect(looksLikePhrase("交周报 改到 明天")).toBe(true);
    expect(looksLikePhrase("交周报优先级高")).toBe(true);
    expect(looksLikePhrase("  完成 交周报  ")).toBe(true);
  });

  it("普通搜索词不触发解析", () => {
    expect(looksLikePhrase("")).toBe(false);
    expect(looksLikePhrase("   ")).toBe(false);
    expect(looksLikePhrase("登录页")).toBe(false);
    expect(looksLikePhrase("周报")).toBe(false);
  });
});

describe("phraseRowCount", () => {
  it("写意图按候选数、查询按条目数", () => {
    expect(
      phraseRowCount({
        kind: "complete",
        target: "a",
        candidates: [
          { id: "1", title: "a", dueAt: null, priority: 2 },
          { id: "2", title: "b", dueAt: null, priority: 2 },
        ],
        dueAt: null,
        dateOnly: false,
        priority: null,
      }),
    ).toBe(2);
    expect(
      phraseRowCount({
        kind: "query",
        query: "overdue",
        summary: null,
        items: [
          {
            id: "1", title: "a", kind: "task", dueAt: null,
            occurredAt: null, sourceName: null, agent: null,
          },
        ],
      }),
    ).toBe(1);
    expect(phraseRowCount(null)).toBe(0);
  });
});

describe("phraseHints", () => {
  it("按起手词给出对应模板", () => {
    expect(phraseHints("完成交周报")).toEqual(["commandPhrases.hint.complete"]);
    expect(phraseHints("把 交周报")).toEqual([
      "commandPhrases.hint.completeBaci",
      "commandPhrases.hint.reschedule",
      "commandPhrases.hint.priority",
    ]);
    expect(phraseHints("本周")).toEqual(["commandPhrases.hint.week"]);
    expect(phraseHints("今天要干嘛")).toEqual(["commandPhrases.hint.today"]);
    expect(phraseHints("哪些 agent 挂了")).toEqual(["commandPhrases.hint.agents"]);
    expect(phraseHints("登录页")).toEqual([]);
  });
});

describe("priorityLabelKey", () => {
  it("1/2/3 映射高/中/低，未知按中", () => {
    expect(priorityLabelKey(1)).toBe("commandPhrases.priority.high");
    expect(priorityLabelKey(2)).toBe("commandPhrases.priority.medium");
    expect(priorityLabelKey(3)).toBe("commandPhrases.priority.low");
    expect(priorityLabelKey(null)).toBe("commandPhrases.priority.medium");
  });
});
