// 任务页组合筛选：状态（主）× 时间范围（次级）必须正交，不能出现第二套筛选状态。
// 固定本地时间断言边界：今天、本周、以后、无日期、逾期，以及状态组合。
import { describe, expect, it } from "vitest";

import {
  endOfWeekExclusive,
  isDueToday,
  matchesFilter,
  matchesPeriod,
  selectTasksByFilter,
} from "../taskQuery";
import type { Priority, Task } from "../types";

const NOW = new Date(2026, 10, 14, 10, 30, 0).getTime(); // 2026-11-14 周六 10:30
const START = new Date(2026, 10, 14, 0, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    description: "",
    status: "pending",
    priority: 1 as Priority,
    category: null,
    tags: [],
    dueAt: null,
    remindAt: null,
    advanceMinutes: null,
    recurrenceRule: null,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    completedAt: null,
    rev: 0,
    serverRev: 0,
    ...overrides,
  };
}

const ids = (tasks: Task[]) => tasks.map((item) => item.id);

describe("endOfWeekExclusive", () => {
  it("周六的下周边界是周一 00:00", () => {
    expect(endOfWeekExclusive(NOW)).toBe(START + 2 * DAY);
  });

  it("周日的下周边界是明天 00:00，不会多跳一周", () => {
    const sunday = new Date(2026, 10, 15, 10, 0, 0).getTime();
    expect(endOfWeekExclusive(sunday)).toBe(new Date(2026, 10, 16, 0, 0, 0).getTime());
  });
});

describe("matchesPeriod", () => {
  it("今天 = 截至今天结束仍未处理的截止时间，含往日逾期", () => {
    expect(matchesPeriod(task({ id: "morning", dueAt: START + 8 * HOUR }), "today", NOW)).toBe(
      true,
    );
    expect(matchesPeriod(task({ id: "late", dueAt: START + 23 * HOUR }), "today", NOW)).toBe(true);
    expect(matchesPeriod(task({ id: "yesterday", dueAt: START - HOUR }), "today", NOW)).toBe(true);
    expect(matchesPeriod(task({ id: "tomorrow", dueAt: START + DAY }), "today", NOW)).toBe(false);
  });

  it("本周包含往日逾期、今天到周日，不含下周一", () => {
    expect(matchesPeriod(task({ id: "yesterday", dueAt: START - HOUR }), "week", NOW)).toBe(true);
    expect(matchesPeriod(task({ id: "today", dueAt: START + 9 * HOUR }), "week", NOW)).toBe(true);
    expect(matchesPeriod(task({ id: "sunday", dueAt: START + DAY + 20 * HOUR }), "week", NOW)).toBe(
      true,
    );
    expect(matchesPeriod(task({ id: "monday", dueAt: START + 2 * DAY }), "week", NOW)).toBe(false);
  });

  it("以后 = 下周一 00:00 起，无日期不混入", () => {
    expect(matchesPeriod(task({ id: "monday", dueAt: START + 2 * DAY }), "later", NOW)).toBe(true);
    expect(matchesPeriod(task({ id: "sunday", dueAt: START + DAY }), "later", NOW)).toBe(false);
    expect(matchesPeriod(task({ id: "none", dueAt: null }), "later", NOW)).toBe(false);
  });

  it("无日期与逾期各自独立", () => {
    expect(matchesPeriod(task({ id: "none", dueAt: null }), "undated", NOW)).toBe(true);
    expect(matchesPeriod(task({ id: "late", dueAt: NOW - 1000 }), "overdue", NOW)).toBe(true);
    expect(
      matchesPeriod(
        task({ id: "done-late", dueAt: NOW - 1000, status: "completed" }),
        "overdue",
        NOW,
      ),
    ).toBe(false);
  });
});

describe("selectTasksByFilter", () => {
  const tasks = [
    task({ id: "pending-today", dueAt: START + 19 * HOUR, priority: 2 }),
    task({ id: "pending-overdue", dueAt: NOW - HOUR, priority: 3 }),
    task({ id: "pending-undated", priority: 1 }),
    task({ id: "done-today", dueAt: START + 8 * HOUR, status: "completed" }),
    task({ id: "done-undated", status: "completed" }),
  ];

  it("状态与时间范围正交组合", () => {
    // 上午 9:30 已过期的任务仍然属于「今天」，所以 pending+today 会包含它
    expect(ids(selectTasksByFilter(tasks, "pending", "today", NOW))).toEqual([
      "pending-overdue",
      "pending-today",
    ]);
    expect(ids(selectTasksByFilter(tasks, "completed", "today", NOW))).toEqual(["done-today"]);
    expect(ids(selectTasksByFilter(tasks, "pending", "undated", NOW))).toEqual([
      "pending-undated",
    ]);
    expect(ids(selectTasksByFilter(tasks, "all", "overdue", NOW))).toEqual(["pending-overdue"]);
  });

  it("组合结果仍按既有排序：未完成 → 优先级 → 截止 → 新建", () => {
    expect(ids(selectTasksByFilter(tasks, "all", "any", NOW))).toEqual([
      "pending-overdue",
      "pending-today",
      "pending-undated",
      "done-today",
      "done-undated",
    ]);
  });

  it("旧的单筛选函数语义保持不变（小组件仍在使用）", () => {
    expect(ids(tasks.filter((item) => matchesFilter(item, "today", NOW)))).toEqual([
      "pending-today",
      "pending-overdue",
    ]);
    expect(isDueToday(task({ id: "done", dueAt: START + HOUR, status: "completed" }), NOW)).toBe(
      false,
    );
  });
});
