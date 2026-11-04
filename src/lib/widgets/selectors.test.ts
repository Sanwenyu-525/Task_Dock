import { describe, expect, it } from "vitest";

import type { AgentRun, Task } from "../bridge";
import { attentionRuns, remainingMs, todayPendingTasks } from "./selectors";

function task(id: string, dueAt: string | null, status: Task["status"] = "pending"): Task {
  return {
    id,
    title: id,
    description: "",
    priority: 2,
    status,
    category: "",
    tags: [],
    due_at: dueAt,
    remind_at: null,
    advance_minutes: 0,
    recurrence: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    linked_agents: 0,
  };
}

function run(id: string, status: string, updatedAt: string): AgentRun {
  return {
    id,
    session_id: "s",
    source_id: "src",
    external_run_id: null,
    task_title: id,
    status,
    started_at: updatedAt,
    updated_at: updatedAt,
    ended_at: null,
    pending_items: [],
  };
}

// 固定「今天」为本地 2026-06-18 12:00
const NOW = new Date(2026, 5, 18, 12, 0, 0).getTime();

describe("todayPendingTasks", () => {
  it("只保留今天到期与已逾期的 pending 任务，并按截止时间升序", () => {
    const tasks = [
      task("tomorrow", new Date(2026, 5, 19, 9, 0).toISOString()),
      task("later-today", new Date(2026, 5, 18, 18, 0).toISOString()),
      task("overdue", new Date(2026, 5, 17, 9, 0).toISOString()),
      task("done", new Date(2026, 5, 18, 9, 0).toISOString(), "completed"),
      task("no-due", null),
      task("broken", "not-a-date"),
    ];

    const ids = todayPendingTasks(tasks, NOW).map((item) => item.id);
    expect(ids).toEqual(["overdue", "later-today"]);
  });

  it("空列表与全部无截止时间时返回空数组", () => {
    expect(todayPendingTasks([], NOW)).toEqual([]);
    expect(todayPendingTasks([task("a", null), task("b", null)], NOW)).toEqual([]);
  });
});

describe("attentionRuns", () => {
  it("按失败 > 等待 > 运行中排序，并限制条数", () => {
    const runs = [
      run("running", "running", "2026-06-18T11:59:00.000Z"),
      run("failed", "failed", "2026-06-18T11:50:00.000Z"),
      run("waiting", "waiting", "2026-06-18T11:55:00.000Z"),
      run("other", "completed", "2026-06-18T11:58:00.000Z"),
    ];

    expect(attentionRuns(runs, NOW, 3).map((item) => item.id)).toEqual([
      "failed",
      "waiting",
      "running",
    ]);
  });
});

describe("remainingMs", () => {
  it("合法时间返回差值，空值与非法值返回 null", () => {
    expect(remainingMs(new Date(NOW + 65_000).toISOString(), NOW)).toBe(65_000);
    expect(remainingMs(null, NOW)).toBeNull();
    expect(remainingMs("oops", NOW)).toBeNull();
  });
});
