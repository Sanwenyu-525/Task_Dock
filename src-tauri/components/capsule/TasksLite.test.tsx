/**
 * @vitest-environment jsdom
 */
//! TasksLite 当前项目 chip（dev workbench Round 1）两态测试：
//! 1. 已设置当前项目且列表命中：chip 显示「项目名 · 分支」（probe ok）；
//! 2. probe 非 ok：chip 只显示项目名；
//! 3. 未设置当前项目：不渲染 chip（不留空壳）；
//! 4. 列表未命中（项目已删除）：不渲染 chip。
//!
//! 常规任务面板断言保持有效：chip 不影响既有列表渲染。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { useSettingsStore } from "../../store/useSettingsStore";
import { useTasksStore } from "../../store/useTasksStore";
import TasksLite from "./TasksLite";
import { invalidateDevProjectCache } from "../devwork/DevProjectContext";
import type { DevGitInfo, DevProject, Task } from "../../lib/bridge";

const FIX_TASK: Task = {
  id: "t1",
  title: "重构剪贴板模块",
  description: "",
  priority: 1,
  status: "pending",
  category: "dev",
  tags: [],
  due_at: null,
  remind_at: null,
  advance_minutes: 0,
  recurrence: null,
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-12T00:00:00Z",
  completed_at: null,
  linked_agents: 0,
};

const FIX_PROJECT: DevProject = {
  id: "p1",
  name: "Task Dock",
  rootPath: "D:\\code\\task-dock",
  note: "",
  createdAt: "2026-11-12T00:00:00Z",
  updatedAt: "2026-11-12T00:00:00Z",
  exists: true,
};

const GIT_OK: DevGitInfo = {
  status: "ok",
  branch: "main",
  detached: false,
  isWorktree: false,
  mainRepoPath: null,
  headSha: null,
  dirtyCount: 0,
  probedAt: "2026-11-12T08:00:00Z",
};

const { listTasks, taskStats, fetchTask, devProjectList, devProjectProbe } = vi.hoisted(() => ({
  listTasks: vi.fn(),
  taskStats: vi.fn(),
  fetchTask: vi.fn(),
  devProjectList: vi.fn(),
  devProjectProbe: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    listTasks,
    taskStats,
    fetchTask,
    devProjectList,
    devProjectProbe,
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
      ...(useSettingsStore.getState().settings ?? {}),
      ...patch,
    })),
    getSettings: vi.fn(async () => useSettingsStore.getState().settings ?? {}),
  };
});

function seedSettings(patch: Record<string, unknown> = {}) {
  useSettingsStore.setState({
    settings: {
      ...(useSettingsStore.getState().settings ?? {}),
      theme: "system",
      mode: "full",
      ...patch,
    } as never,
  });
}

beforeEach(() => {
  invalidateDevProjectCache();
  useTasksStore.setState({
    lite: null,
    liteError: null,
    stats: null,
  } as never);
  listTasks.mockResolvedValue([FIX_TASK]);
  taskStats.mockResolvedValue({ pending: 1, overdue: 0, due_today: 0, completed_today: 0, next_due_at: null });
  fetchTask.mockResolvedValue(FIX_TASK);
  devProjectList.mockResolvedValue({ projects: [FIX_PROJECT] });
  devProjectProbe.mockResolvedValue(GIT_OK);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: null });
});

describe("TasksLite · 当前项目 chip", () => {
  it("已设置且 probe ok：chip 显示「项目名 · 分支」", async () => {
    seedSettings({ workbench_current_project: "p1" });
    render(<TasksLite />);
    const chip = await screen.findByLabelText("当前开发项目：Task Dock");
    await waitFor(() => {
      expect(chip.textContent).toBe("Task Dock · main");
    });
  });

  it("probe 非 ok：chip 只显示项目名", async () => {
    devProjectProbe.mockResolvedValue({ ...GIT_OK, status: "not_a_repo", branch: null });
    seedSettings({ workbench_current_project: "p1" });
    render(<TasksLite />);
    const chip = await screen.findByLabelText("当前开发项目：Task Dock");
    await waitFor(() => {
      expect(chip.textContent).toBe("Task Dock");
    });
  });

  it("未设置当前项目：不渲染 chip，不留空壳", async () => {
    seedSettings({});
    render(<TasksLite />);
    await screen.findByText("全部");
    expect(screen.queryByLabelText(/当前开发项目/)).toBeNull();
    expect(devProjectList).not.toHaveBeenCalled();
  });

  it("设置指向的项目不在列表中（已删除）：不渲染 chip", async () => {
    devProjectList.mockResolvedValue({ projects: [] });
    seedSettings({ workbench_current_project: "p1" });
    render(<TasksLite />);
    await screen.findByText("全部");
    await waitFor(() => {
      expect(screen.queryByLabelText(/当前开发项目/)).toBeNull();
    });
  });
});
