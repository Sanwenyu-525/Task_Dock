/**
 * @vitest-environment jsdom
 */
//! 游戏「构建与测试」模块测试（G1）：手动登记声明、构建/测试列表、归档只读、非游戏降级。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  gameBuildList: vi.fn(),
  gameBuildSave: vi.fn(),
  gameBuildDelete: vi.fn(),
  gameTestList: vi.fn(),
  gameTestSave: vi.fn(),
  gameTestDelete: vi.fn(),
  workspaceItemList: vi.fn(),
  fsOpen: vi.fn(),
}));

vi.mock("./ipc", () => api);

import GameBuildsPanel from "./GameBuildsPanel";

const baseProps = {
  projectId: "p1",
  projectName: "测试游戏",
  kind: "game" as const,
  archived: false,
  rootPath: "D:\\proj",
  rootExists: true,
  devProjectId: null,
  onNotice: vi.fn(),
  switchModule: vi.fn(),
};

const build = {
  id: "b1",
  projectId: "p1",
  target: "Windows",
  engine: "Godot",
  config: "Release",
  status: "success",
  builtAt: "2026-11-16T09:00:00+08:00",
  logPath: "",
  logSummary: "编译通过",
  artifactPath: "",
  source: "manual",
  itemId: null,
  note: "",
  createdAt: "2026-11-16T09:00:00+08:00",
  updatedAt: "2026-11-16T09:00:00+08:00",
  logExists: false,
  artifactExists: false,
};

const testRecord = {
  id: "t1",
  projectId: "p1",
  buildId: "b1",
  title: "主流程回归",
  scope: "关卡进入",
  result: "passed",
  testedAt: "2026-11-16T09:10:00+08:00",
  summary: "3 项通过",
  defectCount: 0,
  itemId: null,
  note: "",
  createdAt: "2026-11-16T09:10:00+08:00",
  updatedAt: "2026-11-16T09:10:00+08:00",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.gameBuildList.mockResolvedValue({ builds: [build] });
  api.gameTestList.mockResolvedValue({ tests: [testRecord] });
  api.workspaceItemList.mockResolvedValue({ items: [] });
});

afterEach(() => cleanup());

describe("GameBuildsPanel", () => {
  it("明确标注手动登记（未接入引擎执行器），并渲染构建与测试记录", async () => {
    render(<GameBuildsPanel {...baseProps} />);

    await waitFor(() => expect(screen.getByText("主流程回归")).toBeTruthy());
    expect(screen.getByTestId("game-manual-notice").textContent).toContain(
      "手动登记（未接入引擎执行器）",
    );
    expect(screen.getByText("Windows")).toBeTruthy();
    expect(screen.getByText("通过")).toBeTruthy();
  });

  it("归档项目隐藏登记入口", async () => {
    render(<GameBuildsPanel {...baseProps} archived />);
    await waitFor(() => expect(screen.getByText("主流程回归")).toBeTruthy());
    expect(screen.queryByText("登记构建")).toBeNull();
    expect(screen.queryByText("登记测试")).toBeNull();
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });

  it("非 game 类型防御性降级", () => {
    render(<GameBuildsPanel {...baseProps} kind="novel" />);
    expect(screen.getByText("构建与测试模块仅对游戏项目开放。")).toBeTruthy();
  });
});
