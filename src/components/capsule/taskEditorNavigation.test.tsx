/**
 * @vitest-environment jsdom
 */
//! 胶囊「编辑任务」导航事务回归（P1）：
//! 切到完整任务页与打开指定任务编辑器必须是**一次**导航事务。
//!
//! 历史缺陷：`TasksLite.edit` 先 `openEditor(task)` 再 `openFullApp("tasks")`，
//! 两次 setTab 都会经过门禁。有未保存草稿时第一次返回 pending 并把「打开编辑器」
//! 绑定到 pendingTab，第二次仍被拦截并覆盖 pendingTab.after —— 编辑意图丢失；
//! 保存中则两次都被拒绝（只留下去重后的提示）。
//!
//! 覆盖：
//! 1. 无草稿：一次导航完成切页 + 解除停靠 + 打开编辑器，undock/applyMode 只一次；
//! 2. 脏草稿：pending 不打开；确认后 discard 一次、编辑器只打开一次且任务正确；
//!    取消后不打开；
//! 3. 保存中：blocked，不打开、无 pendingTab 残留、提示为 warning；
//! 4. 快速连点两次：只保留最后一次目标，确认后只解除停靠一次；
//! 5. 已在任务页：同 Tab + after 同样受门禁约束。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";

const listTasks = vi.fn();
const taskStats = vi.fn();
const applyMode = vi.fn();

vi.mock("../../lib/bridge", () => ({
  listTasks: (...a: unknown[]) => listTasks(...a),
  taskStats: (...a: unknown[]) => taskStats(...a),
  toggleTask: async () => undefined,
  createFromQuickAdd: async () => undefined,
  createTask: async () => undefined,
  updateTask: async () => undefined,
  deleteTask: async () => undefined,
  quickCaptureList: async () => [],
  quickCaptureState: async () => ({ draft: null, last_type: "task", inbox_count: 0 }),
  quickCaptureMarkHandled: async () => undefined,
  quickCaptureDelete: async () => undefined,
  quickCaptureConvertToTask: async () => undefined,
  applyMode: (...a: unknown[]) => applyMode(...a),
}));

import TasksLite from "./TasksLite";
import { openTaskEditor } from "./actions";
import { registerTabGuard } from "../../lib/tabGuard";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useUiStore } from "../../store/useUiStore";
import type { Task } from "../../lib/bridge";

const ANCHOR = new Date();
ANCHOR.setHours(12, 0, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function makeTask(id: string, title: string): Task {
  return {
    id,
    title,
    description: "",
    priority: 0,
    status: "pending",
    category: "",
    tags: [],
    due_at: null,
    remind_at: null,
    advance_minutes: 0,
    recurrence: null,
    created_at: iso(ANCHOR.getTime() - 60_000),
    updated_at: iso(ANCHOR.getTime() - 60_000),
    completed_at: null,
    linked_agents: 0,
  };
}

/** 未被打桩的原始写入方法：每个用例重置它，避免 spy 包装在用例之间串联。 */
const originalOpenEditorNow = useUiStore.getState().openEditorNow;

/** 计数「编辑器真正被打开」的调用次数（after 执行一次 = 打开一次）。 */
function spyOpenEditorNow() {
  const spy = vi.fn();
  useUiStore.setState({
    openEditorNow: (task) => {
      spy(task);
      originalOpenEditorNow(task);
    },
  });
  return spy;
}

const guardCleanups: Array<() => void> = [];

function registerGuard(opts: { dirty?: boolean; busy?: boolean; discard?: () => void }) {
  guardCleanups.push(
    registerTabGuard({
      id: `capsule-task-editor-${guardCleanups.length}-${Math.random()}`,
      label: () => "任务编辑器",
      isDirty: () => opts.dirty ?? false,
      isBusy: () => opts.busy ?? false,
      discard: opts.discard ?? vi.fn(),
    }),
  );
}

beforeEach(() => {
  listTasks.mockReset();
  taskStats.mockReset();
  applyMode.mockReset();
  listTasks.mockResolvedValue([]);
  taskStats.mockResolvedValue({
    pending: 0,
    overdue: 0,
    due_today: 0,
    completed_today: 0,
    next_due_at: null,
  });
  useTasksStore.setState({
    stats: null,
    lite: null,
    liteScope: "all",
    liteTarget: "all",
    liteLoading: false,
    liteError: null,
  });
  useUiStore.setState({
    tab: "tasks",
    pendingTab: null,
    editor: { open: false, task: null },
    toast: null,
    toasts: [],
    helpReturnTab: null,
    openEditorNow: originalOpenEditorNow,
  });
  useEdgeSnapStore.setState({ phase: "free", dockedEdge: null, undock: null });
});

afterEach(() => {
  cleanup();
  while (guardCleanups.length > 0) guardCleanups.pop()!();
  useEdgeSnapStore.getState().reset();
});

describe("胶囊编辑任务 · 单一导航事务", () => {
  it("无草稿：一次导航切页并打开编辑器，undock 只触发一次", async () => {
    const target = makeTask("t1", "整理产品周报");
    listTasks.mockResolvedValue([target]);
    const undock = vi.fn();
    useEdgeSnapStore.setState({ undock });
    const opened = spyOpenEditorNow();

    render(<TasksLite />);
    await screen.findByText("整理产品周报");

    fireEvent.click(screen.getByRole("button", { name: "查看「整理产品周报」详情" }));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "编辑「整理产品周报」" }));
    });

    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().editor.open).toBe(true);
    expect(useUiStore.getState().editor.task?.id).toBe("t1");
    expect(useUiStore.getState().pendingTab).toBeNull();
    // 单次点击只对应一次解除停靠，不再出现「openEditor + openFullApp」两次导航
    expect(undock).toHaveBeenCalledTimes(1);
    expect(undock).toHaveBeenCalledWith("full");
    expect(applyMode).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0]?.id).toBe("t1");
  });

  it("解除停靠在途时不提前打开编辑器，停靠完成后再打开", async () => {
    const target = makeTask("t1", "整理产品周报");
    listTasks.mockResolvedValue([target]);
    let resolveUndock: (ok: boolean) => void = () => {};
    const undock = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveUndock = resolve;
        }),
    );
    useEdgeSnapStore.setState({ undock });
    const opened = spyOpenEditorNow();

    render(<TasksLite />);
    await screen.findByText("整理产品周报");
    fireEvent.click(screen.getByRole("button", { name: "查看「整理产品周报」详情" }));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "编辑「整理产品周报」" }));
    });

    // 导航已切页，但停靠尚未完成：编辑器不能先于窗口解除裁剪态打开
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(undock).toHaveBeenCalledWith("full");
    expect(opened).not.toHaveBeenCalled();

    await act(async () => {
      resolveUndock(true);
    });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0]?.id).toBe("t1");
  });

  it("引擎未注入 undock 时回退 applyMode，同样只执行一次", () => {
    const target = makeTask("t-fallback", "回退任务");
    useEdgeSnapStore.setState({ undock: null });
    const opened = spyOpenEditorNow();

    let result: ReturnType<typeof openTaskEditor> | undefined;
    act(() => {
      result = openTaskEditor(target);
    });

    expect(result).toBe("switched");
    expect(applyMode).toHaveBeenCalledTimes(1);
    expect(applyMode).toHaveBeenCalledWith("full");
    expect(useUiStore.getState().editor.open).toBe(true);
    expect(useUiStore.getState().editor.task?.id).toBe("t-fallback");
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("有脏草稿：返回 pending，不切页、不打开编辑器；取消后仍不打开", () => {
    const discard = vi.fn();
    registerGuard({ dirty: true, discard });
    useUiStore.setState({ tab: "clipboard" });
    const opened = spyOpenEditorNow();

    let result: ReturnType<typeof openTaskEditor> | undefined;
    act(() => {
      result = openTaskEditor(makeTask("t1", "第一次目标"));
    });

    expect(result).toBe("pending");
    expect(useUiStore.getState().tab).toBe("clipboard");
    expect(useUiStore.getState().editor.open).toBe(false);
    expect(useUiStore.getState().pendingTab?.tab).toBe("tasks");
    expect(opened).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();

    act(() => useUiStore.getState().cancelPendingTab());
    expect(useUiStore.getState().tab).toBe("clipboard");
    expect(useUiStore.getState().editor.open).toBe(false);
    expect(useUiStore.getState().pendingTab).toBeNull();
    expect(opened).not.toHaveBeenCalled();
  });

  it("确认离开：discard 一次，编辑器只打开一次且任务正确", () => {
    const discard = vi.fn();
    registerGuard({ dirty: true, discard });
    useUiStore.setState({ tab: "clipboard" });
    const undock = vi.fn();
    useEdgeSnapStore.setState({ undock });
    const opened = spyOpenEditorNow();

    act(() => {
      openTaskEditor(makeTask("t1", "确认目标"));
    });
    expect(useUiStore.getState().pendingTab?.tab).toBe("tasks");

    act(() => useUiStore.getState().confirmPendingTab());

    expect(discard).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().pendingTab).toBeNull();
    // 编辑意图只随这一次强制导航执行一次，不会被后续导航覆盖或重复执行
    expect(opened).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().editor.open).toBe(true);
    expect(useUiStore.getState().editor.task?.id).toBe("t1");
    expect(undock).toHaveBeenCalledTimes(1);
    expect(undock).toHaveBeenCalledWith("full");
  });

  it("保存中：返回 blocked，不打开编辑器、无 pendingTab 残留，并提示保存中", () => {
    const discard = vi.fn();
    registerGuard({ dirty: true, busy: true, discard });
    useUiStore.setState({ tab: "clipboard" });
    const opened = spyOpenEditorNow();

    let result: ReturnType<typeof openTaskEditor> | undefined;
    act(() => {
      result = openTaskEditor(makeTask("t1", "忙碌目标"));
    });

    expect(result).toBe("blocked");
    expect(useUiStore.getState().tab).toBe("clipboard");
    expect(useUiStore.getState().editor.open).toBe(false);
    expect(useUiStore.getState().pendingTab).toBeNull();
    expect(discard).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(
      useUiStore.getState().toasts.some(
        (t) => t.kind === "warning" && t.code === "tab-guard-busy",
      ),
    ).toBe(true);
  });

  it("快速连续点击两次编辑：只保留最后一次目标，确认后只解除停靠一次", () => {
    const discard = vi.fn();
    registerGuard({ dirty: true, discard });
    useUiStore.setState({ tab: "clipboard" });
    const undock = vi.fn();
    useEdgeSnapStore.setState({ undock });
    const opened = spyOpenEditorNow();

    act(() => {
      openTaskEditor(makeTask("t1", "第一次点击"));
      openTaskEditor(makeTask("t2", "第二次点击"));
    });

    // 第二次点击覆盖待确认导航，但 after 仍只有一份且指向最后一次目标
    expect(useUiStore.getState().pendingTab?.tab).toBe("tasks");
    expect(opened).not.toHaveBeenCalled();
    expect(undock).not.toHaveBeenCalled();

    act(() => useUiStore.getState().confirmPendingTab());

    expect(discard).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().editor.open).toBe(true);
    expect(useUiStore.getState().editor.task?.id).toBe("t2");
    expect(undock).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().pendingTab).toBeNull();
  });

  it("当前已在任务页：无草稿可同页编辑；有草稿时同 Tab + after 仍受门禁", () => {
    useUiStore.setState({ tab: "tasks" });
    const opened = spyOpenEditorNow();

    let cleanResult: ReturnType<typeof openTaskEditor> | undefined;
    act(() => {
      cleanResult = openTaskEditor(makeTask("t-now", "当前页目标"));
    });
    expect(cleanResult).toBe("switched");
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().editor.open).toBe(true);
    expect(useUiStore.getState().editor.task?.id).toBe("t-now");
    expect(opened).toHaveBeenCalledTimes(1);

    // 同一 Tab 但 after 会替换草稿，同样必须经过门禁
    useUiStore.setState({ editor: { open: false, task: null } });
    registerGuard({ dirty: true });
    let dirtyResult: ReturnType<typeof openTaskEditor> | undefined;
    act(() => {
      dirtyResult = openTaskEditor(makeTask("t-later", "同页后续目标"));
    });

    expect(dirtyResult).toBe("pending");
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().editor.open).toBe(false);
    expect(useUiStore.getState().pendingTab?.tab).toBe("tasks");
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
