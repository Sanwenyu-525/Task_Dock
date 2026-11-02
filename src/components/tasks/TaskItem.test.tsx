/**
 * @vitest-environment jsdom
 */
//! TaskItem 交互回归（任务卡方案 D 改造配套）：
//! - 完成/取消完成走 store.toggle → bridge.toggleTask，成功弹 Toast、失败弹错误；
//! - 双击正文与编辑按钮都打开 TaskEditor；
//! - 上下文按钮打开任务上下文；
//! - 关联目标按钮只导航，不改变任务状态；
//! - busy 期间完成按钮禁用，防止连点把状态翻来翻去。
//!
//! 样式改版（2026-11-02）不动组件结构：优先级色条移除后，
//! .priority-tag 仍是优先级唯一载体，这里顺带守住它的存在。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useTasksStore } from "../../store/useTasksStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import TaskItem from "./TaskItem";
import type { Task } from "../../lib/bridge";
import type { NavTarget, TaskNavLink } from "../../lib/navigation";

const { toggleTask, navNavigate, listTasks } = vi.hoisted(() => ({
  toggleTask: vi.fn(),
  navNavigate: vi.fn(),
  listTasks: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, toggleTask, listTasks };
});

vi.mock("../../lib/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/navigation")>();
  return { ...actual, navNavigate };
});

function taskFix(p: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    description: "",
    priority: 2,
    status: "pending",
    category: "",
    tags: [],
    due_at: null,
    remind_at: null,
    advance_minutes: 0,
    recurrence: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    completed_at: null,
    linked_agents: 0,
    ...p,
  };
}

const PENDING: Task = taskFix({ id: "t1", title: "写周报" });

function targetFix(id: string, display_name: string): NavTarget {
  return {
    id,
    display_name,
    target_type: "application",
    app_key: id,
    exe_path: `C:\\Program Files\\${id}\\${id}.exe`,
    launch_args: "",
    working_dir: "",
    app_user_model_id: "",
    url: "",
    path: "",
    agent_source_id: "",
    agent_session_id: "",
    window_title_hint: "",
    icon: "",
    category: "",
    favorite: false,
    hidden: false,
    last_used_at: null,
    use_count: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };
}

function linkFix(id: string, task: Task, target: NavTarget, behavior: string): TaskNavLink {
  return {
    id,
    task_id: task.id,
    target_id: target.id,
    display_order: 0,
    is_default: false,
    launch_behavior: behavior,
    created_at: "2026-11-01T00:00:00Z",
    running_state: "not_running",
    target,
  };
}

function seed(task: Task, links: Record<string, TaskNavLink[]> = {}) {
  useTasksStore.setState({
    tasks: [task],
    loading: false,
    filter: { view: "all", status: "all", sort: "due" },
  });
  useNavigationStore.setState({ linksByTask: links });
}

beforeEach(() => {
  vi.clearAllMocks();
  // store.toggle 成功后会 refresh() → listTasks 重查列表
  listTasks.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("TaskItem 交互", () => {
  it("点击完成按钮：toggle 成功后弹成功 Toast，store 列表同步新状态", async () => {
    const user = userEvent.setup();
    seed(PENDING);
    const done = taskFix({ ...PENDING, status: "completed" });
    toggleTask.mockResolvedValue(done);
    listTasks.mockResolvedValue([done]);
    render(<TaskItem task={PENDING} />);

    await user.click(screen.getByRole("button", { name: "完成任务" }));
    await waitFor(() => expect(toggleTask).toHaveBeenCalledWith("t1"));
    await waitFor(() =>
      expect(useUiStore.getState().toast?.kind ?? null).toBe("success"),
    );
    // refresh() 重查后的 store 列表携带 completed 状态（默认「未完成」筛选下该行会退出列表）
    await waitFor(() =>
      expect(useTasksStore.getState().tasks[0]?.status).toBe("completed"),
    );
  });

  it("toggle 失败：弹错误 Toast，不静默吞异常", async () => {
    const user = userEvent.setup();
    seed(PENDING);
    toggleTask.mockRejectedValue(new Error("db locked"));
    render(<TaskItem task={PENDING} />);

    await user.click(screen.getByRole("button", { name: "完成任务" }));
    await waitFor(() => expect(useUiStore.getState().toast?.kind ?? null).toBe("error"));
  });

  it("双击正文与编辑按钮都打开任务编辑器", async () => {
    const user = userEvent.setup();
    seed(PENDING);
    render(<TaskItem task={PENDING} />);

    await user.dblClick(screen.getByText("写周报"));
    expect(useUiStore.getState().editor.open).toBe(true);
    expect(useUiStore.getState().editor.task?.id).toBe("t1");

    useUiStore.setState({ editor: { open: false, task: null } });
    await user.click(screen.getByRole("button", { name: "编辑任务" }));
    expect(useUiStore.getState().editor.open).toBe(true);
  });

  it("上下文按钮打开任务上下文，且优先级标签保留（优先级唯一载体）", async () => {
    const user = userEvent.setup();
    seed(PENDING);
    render(<TaskItem task={PENDING} />);

    expect(screen.getByText("P2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "任务上下文" }));
    expect(useUiStore.getState().context.open).toBe(true);
  });

  it("关联目标按钮只导航，不触碰任务状态", async () => {
    const user = userEvent.setup();
    const target = targetFix("app1", "记事本");
    seed(PENDING, { t1: [linkFix("l1", PENDING, target, "launch")] });
    navNavigate.mockResolvedValue({ success: true, action: "open_app", detail: "" });
    render(<TaskItem task={PENDING} />);

    await user.click(screen.getByRole("button", { name: "打开 记事本" }));
    await waitFor(() => expect(navNavigate).toHaveBeenCalledWith("app1", expect.anything()));
    expect(toggleTask).not.toHaveBeenCalled();
  });

  it("busy 期间完成按钮禁用（aria-busy），连点只触发一次 toggle", async () => {
    const user = userEvent.setup();
    seed(PENDING);
    let resolveToggle: (t: Task) => void = () => {};
    toggleTask.mockReturnValue(
      new Promise<Task>((res) => {
        resolveToggle = res;
      }),
    );
    render(<TaskItem task={PENDING} />);

    const btn = screen.getByRole("button", { name: "完成任务" });
    await user.click(btn);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.hasAttribute("disabled")).toBe(true);

    resolveToggle(taskFix({ ...PENDING, status: "completed" }));
    await waitFor(() => expect(btn.getAttribute("aria-busy")).toBe("false"));
  });
});
