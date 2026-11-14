// 工作区领域纯函数：只测真实存在的语义（项目进度门槛、今日专注排序、最近内容聚合）。
// 这里不构造任何「演示项目」；项目卡数据在未来由 workspace_projects 提供。
import { describe, expect, it } from "vitest";

import {
  buildRecentEntries,
  describeProjectCardInteraction,
  homeGreeting,
  pickFocusTask,
  projectProgressPercent,
  type WorkspaceProjectSummary,
} from "../workspace";
import type { Capture, Note, Priority, Task } from "../types";

const NOW = new Date(2026, 10, 13, 10, 30, 0).getTime(); // 2026-11-13 10:30 本地时间
const START_OF_DAY = new Date(2026, 10, 13, 0, 0, 0).getTime();

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

function note(id: string, updatedAt: number, title = "", body = ""): Note {
  return {
    id,
    title,
    body,
    pinned: false,
    favorited: false,
    createdAt: updatedAt,
    updatedAt,
    rev: 0,
    serverRev: 0,
  };
}

function capture(id: string, createdAt: number, content: string): Capture {
  return { id, clientId: `c-${id}`, content, kind: "text", createdAt, rev: 0, serverRev: 0 };
}

function project(overrides: Partial<WorkspaceProjectSummary>): WorkspaceProjectSummary {
  return {
    id: "p1",
    name: "Task Dock",
    kind: "development",
    status: "active",
    ...overrides,
  };
}

describe("projectProgressPercent", () => {
  it("没有事项统计时返回 null，UI 只能显示状态或数量", () => {
    expect(projectProgressPercent(project({}))).toBeNull();
    expect(projectProgressPercent(project({ itemTotal: 4 }))).toBeNull();
    expect(projectProgressPercent(project({ itemDone: 2 }))).toBeNull();
  });

  it("事项总数为 0 时返回 null，不做 0/0 除法", () => {
    expect(projectProgressPercent(project({ itemTotal: 0, itemDone: 0 }))).toBeNull();
  });

  it("按真实完成数四舍五入，且把越界值夹在 0..100", () => {
    expect(projectProgressPercent(project({ itemTotal: 3, itemDone: 1 }))).toBe(33);
    expect(projectProgressPercent(project({ itemTotal: 8, itemDone: 5 }))).toBe(63);
    expect(projectProgressPercent(project({ itemTotal: 4, itemDone: 9 }))).toBe(100);
    expect(projectProgressPercent(project({ itemTotal: 4, itemDone: -2 }))).toBe(0);
  });
});

describe("pickFocusTask", () => {
  it("没有未完成任务时返回 null（首页给真实空状态）", () => {
    expect(pickFocusTask([], NOW)).toBeNull();
    expect(
      pickFocusTask([task({ id: "done", status: "completed", dueAt: NOW })], NOW),
    ).toBeNull();
  });

  it("逾期优先于今天到期，今天到期优先于未来与无日期", () => {
    const overdue = task({ id: "overdue", dueAt: START_OF_DAY - 1, priority: 1 });
    const today = task({ id: "today", dueAt: START_OF_DAY + 60_000, priority: 3 });
    const future = task({ id: "future", dueAt: START_OF_DAY + 3 * 86_400_000, priority: 3 });
    const none = task({ id: "none", priority: 3 });
    expect(pickFocusTask([none, future, today, overdue], NOW)?.id).toBe("overdue");
  });

  it("同一档内按优先级降序，再按到期时间升序", () => {
    const later = task({ id: "later", dueAt: START_OF_DAY + 60_000, priority: 1 });
    const high = task({ id: "high", dueAt: START_OF_DAY + 120_000, priority: 3 });
    expect(pickFocusTask([later, high], NOW)?.id).toBe("high");

    const earlier = task({ id: "earlier", dueAt: START_OF_DAY + 30_000, priority: 3 });
    expect(pickFocusTask([high, earlier], NOW)?.id).toBe("earlier");
  });

  it("有到期日的任务排在无到期日之前（分档优先于优先级）", () => {
    const dated = task({ id: "dated", dueAt: START_OF_DAY + 60_000, priority: 0 });
    const undated = task({ id: "undated", priority: 3 });
    expect(pickFocusTask([undated, dated], NOW)?.id).toBe("dated");
  });
});

describe("buildRecentEntries", () => {
  it("笔记与收集按时间倒序聚合，最多 3 条", () => {
    const entries = buildRecentEntries(
      [note("n1", NOW - 500, "周会纪要", "讨论了同步边界"), note("n2", NOW - 900, "", "没有标题的正文")],
      [capture("c1", NOW - 100, "买牛奶"), capture("c2", NOW - 800, "另一个速记")],
      3,
    );
    expect(entries.map((entry) => entry.id)).toEqual(["capture-c1", "note-n1", "capture-c2"]);
    expect(entries[0]).toMatchObject({ kind: "capture", title: "买牛奶" });
    expect(entries[1]).toMatchObject({ kind: "note", title: "周会纪要" });
    expect(entries[1]?.snippet).toBe("讨论了同步边界");
  });

  it("笔记没有标题时用正文首行兜底，不生成假标题", () => {
    const [entry] = buildRecentEntries([note("n1", NOW, "", "第一行\n第二行")], [], 3);
    expect(entry?.title).toBe("第一行");
  });

  it("没有笔记与收集时返回空数组", () => {
    expect(buildRecentEntries([], [], 3)).toEqual([]);
  });

  it("limit 为 0 或负数时返回空数组（不依赖 slice 的负数语义）", () => {
    expect(buildRecentEntries([note("n1", NOW, "标题", "正文")], [], 0)).toEqual([]);
    expect(buildRecentEntries([note("n1", NOW, "标题", "正文")], [], -1)).toEqual([]);
  });
});

describe("homeGreeting", () => {
  it("按本地小时分时段，边界值不串档", () => {
    expect(homeGreeting(0)).toBe("夜深了，开发者");
    expect(homeGreeting(5)).toBe("夜深了，开发者");
    expect(homeGreeting(6)).toBe("早上好，开发者");
    expect(homeGreeting(11)).toBe("早上好，开发者");
    expect(homeGreeting(12)).toBe("下午好，开发者");
    expect(homeGreeting(17)).toBe("下午好，开发者");
    expect(homeGreeting(18)).toBe("晚上好，开发者");
    expect(homeGreeting(23)).toBe("晚上好，开发者");
  });
});

describe("describeProjectCardInteraction", () => {
  it("有 onPress 才是按钮，标签不带只读后缀", () => {
    const interaction = describeProjectCardInteraction("Task Dock", true);
    expect(interaction.interactive).toBe(true);
    expect(interaction.accessibilityRole).toBe("button");
    expect(interaction.accessibilityLabel).toBe("项目：Task Dock");
    expect(interaction.accessibilityState.disabled).toBe(false);
  });

  it("无 onPress 明确只读、不可用，不声明 button 角色", () => {
    const interaction = describeProjectCardInteraction("Task Dock", false);
    expect(interaction.interactive).toBe(false);
    expect(interaction.accessibilityRole).toBe("text");
    expect(interaction.accessibilityLabel).toBe("项目：Task Dock，只读");
    expect(interaction.accessibilityState.disabled).toBe(true);
  });
});
