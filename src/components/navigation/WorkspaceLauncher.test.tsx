/**
 * @vitest-environment jsdom
 */
//! 工作区启动器异步生命周期回归：Escape/关闭与取消策略一致、旧任务结果不写入新
//! 任务 UI、连点不产生并发启动、单个失败不阻断后续目标。
//!
//! `navNavigate` 用可控 Promise mock；store 用真实实例 + setState 注入。
//! 只验证前端编排，不计为 Windows 真机启动证据。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useUiStore } from "../../store/useUiStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import type { Task } from "../../lib/bridge";
import { navNavigate, type NavigationResult, type TaskNavLink } from "../../lib/navigation";
import WorkspaceLauncher from "./WorkspaceLauncher";

vi.mock("../../lib/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/navigation")>();
  return { ...actual, navNavigate: vi.fn() };
});

const task = (id: string, title: string) => ({ id, title } as unknown as Task);

function link(id: string, targetId: string, name: string): TaskNavLink {
  return {
    id,
    task_id: "t1",
    target_id: targetId,
    display_order: 0,
    launch_behavior: "focus_or_launch",
    is_default: false,
    running_state: "not_running",
    created_at: "2026-11-01T00:00:00Z",
    target: {
      id: targetId,
      display_name: name,
      target_type: "application",
      app_key: targetId,
      exe_path: `C:\\Program Files\\${targetId}\\${targetId}.exe`,
      launch_args: "",
      working_dir: "",
      app_user_model_id: "",
      url: "",
      path: "",
      agent_source_id: "",
      agent_session_id: "",
      window_title_hint: "",
      icon: "",
      category: "dev",
      favorite: false,
      hidden: false,
      last_used_at: null,
      use_count: 0,
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
    },
  };
}

function okResult(targetId: string): NavigationResult {
  return {
    success: true,
    requested_action: "focus_window",
    actual_action: "focus_window",
    fallback_used: false,
    target_id: targetId,
    reason: undefined,
    verification_level: "window-confirmed",
  };
}

const LINKS = [link("l1", "app1", "应用一"), link("l2", "app2", "应用二")];

function openWorkspace(t: Task, links: TaskNavLink[]) {
  useNavigationStore.setState({ linksByTask: { [t.id]: links } });
  useUiStore.setState({ workspace: { open: true, task: t } });
}

describe("WorkspaceLauncher 生命周期", () => {
  beforeEach(() => {
    vi.mocked(navNavigate).mockReset();
    useSettingsStore.setState({
      settings: { nav_workspace_max: 8 } as never,
    });
    useUiStore.setState({ workspace: { open: false, task: null } });
    useNavigationStore.setState({ linksByTask: {} });
  });
  afterEach(() => cleanup());

  it("启动中 Escape 关闭：只发出已在途的一次导航，后续目标不再启动", async () => {
    let resolveFirst!: (r: NavigationResult) => void;
    vi.mocked(navNavigate).mockImplementation(
      () => new Promise<NavigationResult>((r) => (resolveFirst = r)),
    );
    openWorkspace(task("t1", "任务一"), LINKS);
    render(<WorkspaceLauncher />);

    await userEvent.click(screen.getByRole("button", { name: /启动全部/ }));
    await waitFor(() => expect(navNavigate).toHaveBeenCalledTimes(1));
    expect(vi.mocked(navNavigate).mock.calls[0][0]).toBe("app1");

    fireEvent.keyDown(document, { key: "Escape" });
    // Escape 与关闭按钮策略一致：关闭弹层
    await waitFor(() => expect(useUiStore.getState().workspace.open).toBe(false));

    resolveFirst(okResult("app1"));
    await new Promise((r) => setTimeout(r, 700));
    // 旧批次已被令牌作废：不得继续打开应用二
    expect(navNavigate).toHaveBeenCalledTimes(1);
  });

  it("连点启动全部不产生并发批次", async () => {
    let resolveFirst!: (r: NavigationResult) => void;
    vi.mocked(navNavigate).mockImplementationOnce(
      () => new Promise<NavigationResult>((r) => (resolveFirst = r)),
    );
    vi.mocked(navNavigate).mockImplementation(async (_id, opts) =>
      okResult(opts?.task_link_id ? "app2" : "app1"),
    );
    openWorkspace(task("t1", "任务一"), LINKS);
    render(<WorkspaceLauncher />);

    const btn = screen.getByRole("button", { name: /启动全部/ });
    await userEvent.click(btn);
    fireEvent.click(btn); // 状态尚未刷新时的第二次点击必须被同步锁挡住
    await waitFor(() => expect(navNavigate).toHaveBeenCalledTimes(1));

    resolveFirst(okResult("app1"));
    await waitFor(() => expect(navNavigate).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it("切换任务后旧结果不写入新任务 UI", async () => {
    let resolveFirst!: (r: NavigationResult) => void;
    vi.mocked(navNavigate).mockImplementation(
      () => new Promise<NavigationResult>((r) => (resolveFirst = r)),
    );
    openWorkspace(task("t1", "任务一"), LINKS);
    render(<WorkspaceLauncher />);
    await userEvent.click(screen.getByRole("button", { name: /启动全部/ }));
    await waitFor(() => expect(navNavigate).toHaveBeenCalledTimes(1));

    // 启动中切到任务二（弹层仍打开）
    openWorkspace(task("t2", "任务二"), [link("l3", "app3", "应用三")]);
    resolveFirst(okResult("app1"));
    await new Promise((r) => setTimeout(r, 700));

    // 旧批次不得把「应用一已成功」写进任务二的列表，也不得启动任务二的目标
    expect(screen.queryByText("应用一")).toBeNull();
    expect(navNavigate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("应用三")).toBeTruthy();
  });

  it("单个目标失败不阻断后续无依赖目标", async () => {
    vi.mocked(navNavigate)
      .mockRejectedValueOnce(new Error("目标一失败"))
      .mockResolvedValueOnce(okResult("app2"));
    openWorkspace(task("t1", "任务一"), LINKS);
    render(<WorkspaceLauncher />);

    await userEvent.click(screen.getByRole("button", { name: /启动全部/ }));
    await waitFor(() => expect(navNavigate).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await waitFor(() => expect(screen.getByText(/目标一失败/)).toBeTruthy());
    expect(screen.getByText(/部分成功：1 成功/)).toBeTruthy();
  });
});
