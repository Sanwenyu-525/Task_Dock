// 分组行位置：首/末行决定分组卡圆角；折叠只移除任务行，分组头与计数保留。
import { describe, expect, it } from "vitest";

import type { Priority, Task } from "../../domain/types";
import { buildTaskSections, flattenSections } from "../taskGroups";

const NOW = new Date(2026, 10, 14, 10, 30, 0).getTime();
const START = new Date(2026, 10, 14, 0, 0, 0).getTime();

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

describe("flattenSections", () => {
  const tasks = [
    task({ id: "today-a", dueAt: START + 9 * 3_600_000, priority: 3 }),
    task({ id: "today-b", dueAt: START + 8 * 3_600_000, priority: 2 }),
    task({ id: "undated", priority: 1 }),
    task({ id: "done", status: "completed" }),
  ];

  it("首行 first、末行 last、单行 only", () => {
    const rows = flattenSections(buildTaskSections(tasks, NOW));
    const positions = rows
      .filter((row) => row.type === "task")
      .map((row) => (row.type === "task" ? `${row.task.id}:${row.position}` : ""));
    expect(positions).toEqual([
      "today-a:first",
      "today-b:last",
      "undated:only",
      "done:only",
    ]);
  });

  it("折叠后不产生任务行，但分组头仍在", () => {
    const rows = flattenSections(buildTaskSections(tasks, NOW), new Set(["today"]));
    expect(rows[0]).toMatchObject({ type: "section" });
    expect(rows.some((row) => row.type === "task" && row.task.id.startsWith("today"))).toBe(false);
    expect(rows.filter((row) => row.type === "task")).toHaveLength(2);
  });
});
