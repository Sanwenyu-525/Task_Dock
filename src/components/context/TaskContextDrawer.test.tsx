/**
 * @vitest-environment jsdom
 */
//! 任务上下文抽屉：窗口捕获改为抽屉内展开区（不是第二层模态），保存现场同步防重入。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Task, TaskContext } from "../../lib/bridge";

const taskContextMock = vi.fn();
const workspaceCaptureWindows = vi.fn();
const workspaceCreate = vi.fn();
const workspaceRestoreStatus = vi.fn();
const taskReminderLinkGet = vi.fn();
const taskReminderLinkSet = vi.fn();
const taskReminderLinkClear = vi.fn();
const scenarioList = vi.fn();
const workspaceList = vi.fn();

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    taskContext: (...a: unknown[]) => taskContextMock(...a),
    workspaceCaptureWindows: (...a: unknown[]) => workspaceCaptureWindows(...a),
    workspaceCreate: (...a: unknown[]) => workspaceCreate(...a),
    workspaceRestoreStatus: (...a: unknown[]) => workspaceRestoreStatus(...a),
    taskReminderLinkGet: (...a: unknown[]) => taskReminderLinkGet(...a),
    taskReminderLinkSet: (...a: unknown[]) => taskReminderLinkSet(...a),
    taskReminderLinkClear: (...a: unknown[]) => taskReminderLinkClear(...a),
    scenarioList: (...a: unknown[]) => scenarioList(...a),
    workspaceList: (...a: unknown[]) => workspaceList(...a),
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
  taskReminderLinkGet.mockReset().mockResolvedValue(null);
  taskReminderLinkSet.mockReset().mockResolvedValue({
    taskId: "t1",
    targetKind: "scene",
    targetId: "sc-1",
    label: "深度工作",
    updatedAt: "2026-11-08T00:00:00Z",
  });
  taskReminderLinkClear.mockReset().mockResolvedValue(undefined);
  scenarioList.mockReset();
  workspaceList.mockReset();
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

describe("TaskContextDrawer 提醒联动", () => {
  it("未关联时展示空态；关联场景后显示当前目标并可清除", async () => {
    taskReminderLinkGet.mockResolvedValue({
      taskId: "t1",
      targetKind: "scene",
      targetId: "sc-1",
      label: "深度工作",
      updatedAt: "2026-11-08T00:00:00Z",
    });
    render(<TaskContextDrawer />);
    await waitFor(() => expect(screen.getByText("深度工作")).toBeTruthy());
    expect(screen.getByText("场景")).toBeTruthy();
    // 清除：真实命令 + 更新为未关联
    fireEvent.click(screen.getByRole("button", { name: "清除提醒联动" }));
    await waitFor(() => expect(taskReminderLinkClear).toHaveBeenCalledWith("t1"));
    await waitFor(() =>
      expect(screen.getByText("未关联。可为本任务选择一个场景或工作现场。")).toBeTruthy(),
    );
  });

  it("展开候选列表按需加载（场景全量、现场按本任务过滤），选择后写真实命令", async () => {
    scenarioList.mockResolvedValue([
      { id: "sc-1", name: "深度工作", icon: null, app_count: 1, url_count: 0, folder_count: 0, linked_workflow_id: null, last_entered_at: null, created_at: "", updated_at: "" },
    ]);
    workspaceList.mockResolvedValue([]);
    render(<TaskContextDrawer />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "关联场景…" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "关联场景…" }));
    expect(scenarioList).toHaveBeenCalledTimes(1);
    fireEvent.click(await screen.findByRole("button", { name: "深度工作" }));
    await waitFor(() =>
      expect(taskReminderLinkSet).toHaveBeenCalledWith("t1", "scene", "sc-1"),
    );
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining("进入场景"),
        expect.objectContaining({ kind: "success" }),
      ),
    );

    // 现场候选按 taskId 过滤查询
    fireEvent.click(screen.getByRole("button", { name: "关联现场…" }));
    await waitFor(() => expect(workspaceList).toHaveBeenCalledWith("t1"));
  });

  it("读取联动失败如实展示原因，不影响其余分区", async () => {
    taskReminderLinkGet.mockRejectedValue(new Error("IPC 未就绪"));
    render(<TaskContextDrawer />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("读取提醒联动失败");
    expect(alert.textContent).toContain("IPC 未就绪");
    // 其余分区照常渲染
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /捕获窗口/ })).toBeTruthy(),
    );
  });

  it("关联目标被后端拒绝（已删除）时报错不伪装成功", async () => {
    scenarioList.mockResolvedValue([
      { id: "sc-gone", name: "已删场景", icon: null, app_count: 0, url_count: 0, folder_count: 0, linked_workflow_id: null, last_entered_at: null, created_at: "", updated_at: "" },
    ]);
    taskReminderLinkSet.mockRejectedValue(new Error("关联目标不存在或已被删除"));
    render(<TaskContextDrawer />);
    fireEvent.click(await screen.findByRole("button", { name: "关联场景…" }));
    fireEvent.click(await screen.findByRole("button", { name: "已删场景" }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining("关联场景失败"),
        expect.objectContaining({ kind: "error" }),
      ),
    );
  });

  it("关闭态先渲染再打开不触发 React #310（hooks 顺序回归）", async () => {
    // 组件常驻挂载：先以关闭态渲染，再打开抽屉——hooks 数量必须在两种状态一致。
    // 回归背景：21f5887 把删除确认的 useRef/useEffect 放到早退 return 之后，
    // 真机上从关闭态打开抽屉即崩（界面渲染失败），jsdom 旧测试从打开态首渲染测不出来。
    taskReminderLinkGet.mockResolvedValue(null);
    const view = render(<TaskContextDrawer />);
    expect(screen.queryByRole("dialog", { name: "任务上下文" })).toBeNull();
    act(() => {
      useUiStore.setState({ context: { open: true, task } });
    });
    expect(
      await screen.findByRole("dialog", { name: "任务上下文" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "关联场景…" })).toBeTruthy(),
    );
    view.unmount();
  });
});
