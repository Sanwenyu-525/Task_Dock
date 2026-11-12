/**
 * @vitest-environment jsdom
 */
//! DevProjectContext（开发现场区块）交互测试：
//! 1. 已设当前项目：加载列表 + probe ok 的 Git 摘要（分支 · 未提交 · worktree）；
//! 2. probe 非 ok 的降级文案（not_a_repo）；dirtyCount=null 不显示「0 处未提交」；
//! 3. 空态：列表为空显示空态与「新建项目」；
//! 4. 项目选择/设为当前：写入设置键 workbench_current_project（断言 update_settings 参数）；
//! 5. 新建表单校验：名称/路径必填，合法输入调用 dev_project_save 并强制刷新列表；
//! 6. 删除走 ConfirmDialog 两段确认：先开确认框，确认后才调用 dev_project_delete；
//! 7. exists=false 显示失效徽标，不自动删除。
//!
//! bridge mock：importOriginal 保留类型；模块级缓存（30s TTL）在每个用例前作废。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useLocaleStore } from "../../i18n";
import DevProjectContext, { invalidateDevProjectCache } from "./DevProjectContext";
import type { DevGitInfo, DevProject } from "../../lib/bridge";

const FIX_PROJECTS: DevProject[] = [
  {
    id: "p1",
    name: "Task Dock",
    rootPath: "D:\\code\\task-dock",
    note: "",
    createdAt: "2026-11-12T00:00:00Z",
    updatedAt: "2026-11-12T00:00:00Z",
    exists: true,
  },
  {
    id: "p2",
    name: "Side Project",
    rootPath: "D:\\code\\side",
    note: "",
    createdAt: "2026-11-12T00:00:00Z",
    updatedAt: "2026-11-12T00:00:00Z",
    exists: true,
  },
];

const GIT_OK: DevGitInfo = {
  status: "ok",
  branch: "main",
  detached: false,
  isWorktree: true,
  mainRepoPath: "D:\\code\\task-dock",
  headSha: "abc1234",
  dirtyCount: 3,
  probedAt: "2026-11-12T08:00:00Z",
};

const { devProjectList, devProjectProbe, devProjectSave, devProjectDelete, updateSettings } =
  vi.hoisted(() => ({
    devProjectList: vi.fn(),
    devProjectProbe: vi.fn(),
    devProjectSave: vi.fn(),
    devProjectDelete: vi.fn(),
    updateSettings: vi.fn(),
  }));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    devProjectList,
    devProjectProbe,
    devProjectSave,
    devProjectDelete,
    updateSettings,
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
  useLocaleStore.setState({ locale: "zh-CN", preference: "zh-CN" });
  useUiStore.setState({ toasts: [], toast: null });
  seedSettings();
  devProjectList.mockResolvedValue({ projects: FIX_PROJECTS });
  devProjectProbe.mockResolvedValue(GIT_OK);
  devProjectSave.mockImplementation(async (input: { id: string | null; name: string }) => ({
    project: {
      id: input.id ?? "p-new",
      name: input.name,
      rootPath: "D:\\code\\new",
      note: "",
      createdAt: "2026-11-12T00:00:00Z",
      updatedAt: "2026-11-12T00:00:00Z",
      exists: true,
    },
  }));
  devProjectDelete.mockResolvedValue({ ok: true });
  updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
    ...(useSettingsStore.getState().settings ?? {}),
    ...patch,
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: null });
});

describe("DevProjectContext · 加载与 Git 摘要", () => {
  it("已设当前项目：显示名称/路径与 probe ok 的分支、未提交数、worktree 标记", async () => {
    seedSettings({ workbench_current_project: "p1" });
    render(<DevProjectContext />);
    expect((await screen.findAllByText("Task Dock")).length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText(/main/)).toBeTruthy();
    expect(screen.getByText(/3 处未提交/)).toBeTruthy();
    expect(screen.getByText(/worktree/)).toBeTruthy();
    // probe 只对当前项目目录发起
    await waitFor(() => {
      expect(devProjectProbe).toHaveBeenCalledWith("D:\\code\\task-dock");
    });
  });

  it("probe not_a_repo：降级显示「不是 Git 仓库」，不伪造分支", async () => {
    devProjectProbe.mockResolvedValue({
      status: "not_a_repo",
      branch: null,
      detached: false,
      isWorktree: false,
      mainRepoPath: null,
      headSha: null,
      dirtyCount: null,
      probedAt: "2026-11-12T08:00:00Z",
    } satisfies DevGitInfo);
    seedSettings({ workbench_current_project: "p1" });
    render(<DevProjectContext />);
    expect(await screen.findByText("不是 Git 仓库")).toBeTruthy();
    expect(screen.queryByText(/main/)).toBeNull();
  });

  it("status=ok 但 dirtyCount=null：不显示未提交段（不得显示为 0）", async () => {
    devProjectProbe.mockResolvedValue({ ...GIT_OK, dirtyCount: null });
    seedSettings({ workbench_current_project: "p1" });
    render(<DevProjectContext />);
    expect(await screen.findByText(/main/)).toBeTruthy();
    expect(screen.queryByText(/未提交/)).toBeNull();
  });
});

describe("DevProjectContext · 空态与选择", () => {
  it("列表为空：显示空态与「新建项目」按钮", async () => {
    devProjectList.mockResolvedValue({ projects: [] });
    render(<DevProjectContext />);
    expect(await screen.findByText("还没有开发项目")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建项目" })).toBeTruthy();
  });

  it("未设当前项目：不显示当前项目卡与失效提示", async () => {
    render(<DevProjectContext />);
    expect(await screen.findByText("Side Project")).toBeTruthy();
    expect(screen.queryByText("当前项目已不存在（可能已被删除），请重新选择")).toBeNull();
  });

  it("「设为当前」写入设置键 workbench_current_project", async () => {
    seedSettings({ workbench_current_project: "p1" });
    render(<DevProjectContext />);
    expect((await screen.findAllByText("Task Dock")).length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: "设为当前" }));
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({ workbench_current_project: "p2" });
    });
  });
});

describe("DevProjectContext · 新建表单", () => {
  it("空表单提交：先提示名称必填，再提示路径必填，不调用保存", async () => {
    render(<DevProjectContext />);
    fireEvent.click(await screen.findByRole("button", { name: "新建项目" }));
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));
    expect(await screen.findByText("请填写项目名称")).toBeTruthy();
    expect(devProjectSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "新项目" } });
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));
    expect(await screen.findByText("请填写目录路径")).toBeTruthy();
    expect(devProjectSave).not.toHaveBeenCalled();
  });

  it("合法输入：调用 dev_project_save 并强制刷新列表", async () => {
    render(<DevProjectContext />);
    fireEvent.click(await screen.findByRole("button", { name: "新建项目" }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "新项目" } });
    fireEvent.change(screen.getByLabelText("目录路径"), { target: { value: "D:\\code\\new" } });
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));
    await waitFor(() => {
      expect(devProjectSave).toHaveBeenCalledWith({
        id: null,
        name: "新项目",
        rootPath: "D:\\code\\new",
      });
    });
    // 保存成功后作废缓存并重读列表（第二次调用）
    await waitFor(() => {
      expect(devProjectList.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("DevProjectContext · 删除确认与失效徽标", () => {
  it("删除先开确认框，确认后才调用 dev_project_delete", async () => {
    seedSettings({ workbench_current_project: "p1" });
    render(<DevProjectContext />);
    expect((await screen.findAllByText("Task Dock")).length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: '删除项目「Side Project」' }));
    // 确认框出现，但尚未删除
    expect(await screen.findByText("删除开发项目")).toBeTruthy();
    expect(devProjectDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(devProjectDelete).toHaveBeenCalledWith("p2");
    });
  });

  it("exists=false 显示失效徽标（不自动删除）", async () => {
    devProjectList.mockResolvedValue({
      projects: [{ ...FIX_PROJECTS[1], exists: false }],
    });
    render(<DevProjectContext />);
    expect((await screen.findAllByText("目录失效")).length).toBeGreaterThanOrEqual(1);
    expect(devProjectDelete).not.toHaveBeenCalled();
  });
});
