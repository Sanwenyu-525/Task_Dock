/**
 * @vitest-environment jsdom
 */
//! 任务上下文抽屉：窗口捕获改为抽屉内展开区（不是第二层模态），保存现场同步防重入。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Task, TaskContext } from "../../lib/bridge";

const taskContextMock = vi.fn();
const workspaceCaptureWindows = vi.fn();
const workspaceCreate = vi.fn();
const workspaceRestoreStatus = vi.fn();

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    taskContext: (...a: unknown[]) => taskContextMock(...a),
    workspaceCaptureWindows: (...a: unknown[]) => workspaceCaptureWindows(...a),
    workspaceCreate: (...a: unknown[]) => workspaceCreate(...a),
    workspaceRestoreStatus: (...a: unknown[]) => workspaceRestoreStatus(...a),
    onWorkspaceChanged: async () => () => {},
    onWorkspaceRestoreProgress: async () => () => {},
  };
});

import TaskContextDrawer from "./TaskContextDrawer";
import { useUiStore } from "../../store/useUiStore";
import { useSettingsStore } from "../../store/useSettingsStore";

const task = {
  id: "t1",
  title: "写周报",
  description: "",
  priority: 2,
  status: "pending",
  category: "",
  tags: [],
  due_at: null,
  remind_at: null,
  advance_minutes: 0,
  recurrence: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  completed_at: null,
  linked_agents: 0,
} as Task;

function context(): TaskContext {
  return {
    task,
    agents: [],
    navigation: [],
    clipboard: [],
    snapshots: [],
    actions: [],
  };
}

const showToast = vi.fn();

beforeEach(() => {
  taskContextMock.mockReset().mockResolvedValue(context());
  workspaceCaptureWindows.mockReset().mockResolvedValue([
    { hwnd: 101, title: "记事本", class_name: "Notepad", exe_path: "C:\\Windows\\notepad.exe", is_minimized: false },
    { hwnd: 102, title: "未知", class_name: "Unknown", exe_path: null, is_minimized: false },
  ]);
  workspaceCreate.mockReset();
  workspaceRestoreStatus.mockReset().mockResolvedValue({
    running: false,
    snapshot_id: null,
    cancel_requested: false,
  });
  showToast.mockClear();
  useUiStore.setState({
    context: { open: true, task },
    closeContext: vi.fn(),
    openClipboard: vi.fn(),
    setTab: vi.fn(),
    showToast,
  });
  useSettingsStore.setState({ settings: { workspace_enabled: true } as never });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ context: { open: false, task: null } });
});

describe("TaskContextDrawer 窗口捕获", () => {
  it("在抽屉内展开捕获区，保留不可选窗口提示，不叠加 modal-mask", async () => {
    render(<TaskContextDrawer />);
    await waitFor(() => expect(screen.getByRole("button", { name: /捕获窗口/ })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /捕获窗口/ }));

    const section = await screen.findByRole("region", { name: "捕获当前窗口" });
    expect(section).toBeTruthy();
    expect(document.querySelector(".modal-mask")).toBeNull();
    expect(document.querySelector(".modal.capture-modal")).toBeNull();

    expect(await screen.findByText("记事本")).toBeTruthy();
    expect(screen.getByText("无法识别进程（将跳过）")).toBeTruthy();
    expect(screen.getByText(/已选 1 \/ 2/)).toBeTruthy();
  });

  it("连点保存现场只创建一次", async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    workspaceCreate.mockReturnValueOnce(
      new Promise<unknown>((resolve) => {
        resolveCreate = resolve;
      }),
    );

    render(<TaskContextDrawer />);
    await waitFor(() => expect(screen.getByRole("button", { name: /捕获窗口/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /捕获窗口/ }));
    const save = await screen.findByRole("button", { name: "保存现场" });

    fireEvent.click(save);
    fireEvent.click(save);
    expect(workspaceCreate).toHaveBeenCalledTimes(1);

    resolveCreate({
      id: "s1",
      task_id: "t1",
      task_title: "写周报",
      name: "写周报 · 现场",
      note: "",
      source: "task",
      item_count: 1,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_restored_at: null,
      restore_count: 0,
    });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("已保存现场"),
      expect.objectContaining({ kind: "success" }),
    ));
  });

  it("枚举失败给出原因与重试入口，保存按钮不可用", async () => {
    workspaceCaptureWindows.mockRejectedValueOnce(new Error("窗口枚举被拒绝"));
    render(<TaskContextDrawer />);
    await waitFor(() => expect(screen.getByRole("button", { name: /捕获窗口/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /捕获窗口/ }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("窗口枚举被拒绝"),
    );
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存现场" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
