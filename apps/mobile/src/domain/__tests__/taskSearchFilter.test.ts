// 任务页组合筛选：验收表 02/09 的纯逻辑部分。
// 搜索框常驻后，关键词必须能与状态、时间范围叠加；快速连续切换只由最后一次条件决定
// （筛选是本地纯计算，不在筛选时发起数据库请求，因此不存在旧请求覆盖新条件）。
import { describe, expect, it } from "vitest";

import type { Task } from "../types";
import { matchesQuery, selectTasksByFilter } from "../taskQuery";

const NOW = new Date(2026, 10, 17, 10, 0, 0).getTime(); // 2026-11-17 10:00 本地

function task(overrides: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    description: "",
    status: "pending",
    priority: 0,
    category: null,
    tags: [],
    dueAt: null,
    remindAt: null,
    advanceMinutes: null,
    recurrenceRule: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    rev: 0,
    serverRev: 0,
    ...overrides,
  };
}

const tasks: Task[] = [
  task({ id: "1", title: "写周报", category: "工作", tags: ["weekly"], dueAt: NOW + 60_000 }),
  task({ id: "2", title: "买牛奶", category: "生活", description: "顺便买鸡蛋" }),
  task({ id: "3", title: "修复登录", status: "completed", tags: ["bug"], dueAt: NOW - 86_400_000 }),
  task({ id: "4", title: "下周计划", dueAt: NOW + 7 * 86_400_000 }),
  task({ id: "5", title: "无日期任务" }),
];

describe("matchesQuery", () => {
  it("空查询与纯空白：视为不过滤", () => {
    expect(matchesQuery(tasks[0], "")).toBe(true);
    expect(matchesQuery(tasks[0], "   ")).toBe(true);
  });

  it("标题、描述、分类、标签都能命中，且大小写不敏感", () => {
    expect(matchesQuery(tasks[0], "周报")).toBe(true);
    expect(matchesQuery(tasks[1], "鸡蛋")).toBe(true);
    expect(matchesQuery(tasks[0], "工作")).toBe(true);
    expect(matchesQuery(tasks[0], "WEEKLY")).toBe(true);
    expect(matchesQuery(tasks[3], "不存在")).toBe(false);
  });
});

describe("搜索 × 状态 × 时间范围组合", () => {
  it("关键词与状态筛选叠加：已完成的搜索命中不会被当成待办", () => {
    const visible = selectTasksByFilter(
      tasks.filter((item) => matchesQuery(item, "登录")),
      "completed",
      "any",
      NOW,
    );
    expect(visible.map((item) => item.id)).toEqual(["3"]);
  });

  it("关键词与时间范围叠加：今天只保留今天到期且未完成的命中", () => {
    const visible = selectTasksByFilter(
      tasks.filter((item) => matchesQuery(item, "")),
      "pending",
      "today",
      NOW,
    );
    expect(visible.map((item) => item.id)).toContain("1");
    expect(visible.map((item) => item.id)).not.toContain("3"); // 已完成
  });

  it("快速连续切换：只按最后一次条件返回（无旧结果混入）", () => {
    const first = selectTasksByFilter(tasks, "pending", "any", NOW);
    const second = selectTasksByFilter(tasks, "completed", "any", NOW);
    const final = selectTasksByFilter(tasks.filter((item) => matchesQuery(item, "计划")), "pending", "later", NOW);
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((item) => item.id)).toEqual(["3"]);
    expect(final.map((item) => item.id)).toEqual(["4"]);
  });

  it("空关键词 + 无匹配：返回空列表而不是整个任务集", () => {
    const visible = selectTasksByFilter(tasks.filter((item) => matchesQuery(item, "zzz")), "all", "any", NOW);
    expect(visible).toEqual([]);
  });
});
