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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useTasksStore } from "../../store/useTasksStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import TaskItem from "./TaskItem";
import type { Task, TaskFilter } from "../../lib/bridge";
import type { NavTarget, TaskNavLink } from "../../lib/navigation";
import { EXIT_MS } from "../../lib/motion";

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

/**
 * 接管离场动画的 EXIT_MS 定时器：需要「在 190ms 窗口内连续做两次交互」的用例
 * 在高负载下会被真实计时器抢先结束。只拦截恰好 EXIT_MS 的定时器，返回
 * `runAll` 手动推进与 `restore` 还原。
 */
function controlExitTimers() {
  const pending: Array<() => void> = [];
  const realSetTimeout = window.setTimeout.bind(window);
  const spy = vi
    .spyOn(window, "setTimeout")
    .mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === EXIT_MS && typeof handler === "function") {
        pending.push(() => (handler as (...rest: unknown[]) => void)(...args));
        return 0 as unknown as number;
      }
      return realSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout);
  return {
    runAll: async () => {
      await act(async () => {
        pending.splice(0).forEach((run) => run());
      });
    },
    restore: () => spy.mockRestore(),
  };
}

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
    exitHolds: [],
  });
  useNavigationStore.setState({ linksByTask: links });
}

/** 以 store 列表渲染多行任务，并带真实列表名入口（焦点回退目标）。 */
function StoreListHarness() {
  const tasks = useTasksStore((s) => s.tasks);
  return (
    <div className="tasks-panel">
      <input className="quick-add-input" aria-label="快速添加" />
      <div className="task-list">
        {tasks.map((task) => (
          <TaskItem key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}

function seedList(tasks: Task[]) {
  useTasksStore.setState({
    tasks,
    loading: false,
    error: null,
    filter: { view: "all", status: "pending", sort: "due" },
    exitHolds: [],
  });
  useNavigationStore.setState({ linksByTask: {} });
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

  it("默认「未完成」筛选下完成任务：立即提交后端，成功后才播离场，动画结束再刷新列表", async () => {
    const user = userEvent.setup();
    seed(PENDING);
    useTasksStore.setState({ filter: { view: "all", status: "pending", sort: "due" } });
    const done = taskFix({ ...PENDING, status: "completed" });
    let resolveToggle: (t: Task) => void = () => {};
    toggleTask.mockReturnValue(
      new Promise<Task>((res) => {
        resolveToggle = res;
      }),
    );
    listTasks.mockResolvedValue([done]);
    const { container } = render(<TaskItem task={PENDING} />);

    const row = container.querySelector<HTMLElement>(".task-item")!;
    await user.click(screen.getByRole("button", { name: "完成任务" }));
    // 动画绝不挡在后端写入前面：点击即提交，执行中不进入离场
    expect(toggleTask).toHaveBeenCalledWith("t1");
    expect(row.classList.contains("leaving")).toBe(false);

    resolveToggle(done);
    // 只有真成功、且该行要退出当前筛选时才离场；此时列表还没刷新
    await waitFor(() => expect(row.classList.contains("leaving")).toBe(true));
    expect(row.classList.contains("removing")).toBe(false);
    expect(row.style.getPropertyValue("--clip-exit-h")).not.toBe("");
    expect(listTasks).not.toHaveBeenCalled();

    // 离场播完才按服务端结果同步列表（行自然退出「未完成」筛选）
    await waitFor(() => expect(listTasks).toHaveBeenCalled());
    await waitFor(() =>
      expect(useTasksStore.getState().tasks[0]?.status).toBe("completed"),
    );
    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("success"));
    // 撤销入口必须保留
    expect(useUiStore.getState().toast?.action?.label).toBe("撤销");
  });

  it("未完成筛选下 toggle 失败：不播成功离场、不刷新列表，行留在原位", async () => {
    const user = userEvent.setup();
    seed(PENDING);
    useTasksStore.setState({ filter: { view: "all", status: "pending", sort: "due" } });
    toggleTask.mockRejectedValue(new Error("db locked"));
    const { container } = render(<TaskItem task={PENDING} />);

    const row = container.querySelector<HTMLElement>(".task-item")!;
    await user.click(screen.getByRole("button", { name: "完成任务" }));

    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("error"));
    expect(row.classList.contains("leaving")).toBe(false);
    expect(row.style.getPropertyValue("--clip-exit-h")).toBe("");
    expect(listTasks).not.toHaveBeenCalled();
    expect(useTasksStore.getState().tasks[0]?.status).toBe("pending");
    // 按钮状态恢复，失败后可以重试
    expect(screen.getByRole("button", { name: "完成任务" }).hasAttribute("disabled")).toBe(false);
  });

  it("减少动态：成功即同步列表，不等离场时长、不留离场态", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    try {
      const user = userEvent.setup();
      seed(PENDING);
      useTasksStore.setState({ filter: { view: "all", status: "pending", sort: "due" } });
      const done = taskFix({ ...PENDING, status: "completed" });
      toggleTask.mockResolvedValue(done);
      listTasks.mockResolvedValue([done]);
      const { container } = render(<TaskItem task={PENDING} />);

      await user.click(screen.getByRole("button", { name: "完成任务" }));
      await waitFor(() => expect(listTasks).toHaveBeenCalled());
      const row = container.querySelector<HTMLElement>(".task-item")!;
      expect(row.classList.contains("leaving")).toBe(false);
      expect(useTasksStore.getState().tasks[0]?.status).toBe("completed");
    } finally {
      window.matchMedia = original;
    }
  });

  it("toggle 失败：弹错误 Toast，不静默吞异常", async () => {    const user = userEvent.setup();
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

describe("TaskItem 离场期隔离与焦点交接", () => {
  const A = taskFix({ id: "a", title: "任务甲" });
  const B = taskFix({ id: "b", title: "任务乙" });
  const C = taskFix({ id: "c", title: "任务丙" });

  function checkOf(container: HTMLElement, id: string) {
    return container.querySelector<HTMLButtonElement>(`[data-task-id="${id}"] .task-check`)!;
  }

  it("完成按钮聚焦后完成任务：离场结束焦点交给相邻任务", async () => {
    const user = userEvent.setup();
    seedList([A, B]);
    toggleTask.mockResolvedValue(taskFix({ ...A, status: "completed" }));
    listTasks.mockResolvedValue([B]);
    const { container } = render(<StoreListHarness />);

    await user.click(checkOf(container, "a"));
    await waitFor(() => expect(container.querySelector('[data-task-id="a"]')?.classList.contains("leaving")).toBe(true));

    await waitFor(() => expect(document.activeElement).toBe(checkOf(container, "b")));
  });

  it("离场期 Tab/键盘隔离：整行 inert + aria-hidden，完成按钮禁用", async () => {
    const user = userEvent.setup();
    seedList([A, B]);
    toggleTask.mockResolvedValue(taskFix({ ...A, status: "completed" }));
    listTasks.mockResolvedValue([B]);
    const { container } = render(<StoreListHarness />);

    await user.click(checkOf(container, "a"));
    const row = container.querySelector<HTMLElement>('[data-task-id="a"]')!;
    await waitFor(() => expect(row.classList.contains("leaving")).toBe(true));

    // inert 是浏览器层「不可聚焦/不可点击」的契约；jsdom 不执行 Tab 拦截，
    // 这里守住组件产出的隔离属性，真机行为单独验收。
    expect(row.hasAttribute("inert")).toBe(true);
    expect(row.getAttribute("aria-hidden")).toBe("true");
    expect(checkOf(container, "a").hasAttribute("disabled")).toBe(true);

    // 相邻任务不受影响，仍可正常聚焦
    expect(checkOf(container, "b").hasAttribute("disabled")).toBe(false);

    // 等这次离场彻底结束，避免遗留定时器影响后续用例
    await waitFor(() => expect(container.querySelector('[data-task-id="a"]')).toBeNull());
  });

  it("离场期 Enter/Space 不会再次提交", async () => {
    const user = userEvent.setup();
    seedList([A, B]);
    toggleTask.mockResolvedValue(taskFix({ ...A, status: "completed" }));
    listTasks.mockResolvedValue([B]);
    const exit = controlExitTimers();
    try {
      const { container } = render(<StoreListHarness />);

      await user.click(checkOf(container, "a"));
      // 提交离场态（真实计时器可能在全量并发时先把 190ms 动画走完，导致行已被移除）：
      // act 退出会强制 flush 渲染，随后的断言同步读取，离场动画本身不缩短。
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('[data-task-id="a"]')?.classList.contains("leaving")).toBe(true);

      const btn = checkOf(container, "a");
      fireEvent.keyDown(btn, { key: "Enter" });
      fireEvent.keyDown(btn, { key: " " });
      fireEvent.click(btn);
      expect(toggleTask).toHaveBeenCalledTimes(1);

      // 动画结束才允许后台刷新与收尾，避免计时器在键盘断言前抢跑
      await exit.runAll();
      await waitFor(() => expect(listTasks).toHaveBeenCalled());
      await waitFor(() => expect(container.querySelector('[data-task-id="a"]')).toBeNull());
    } finally {
      exit.restore();
    }
  });

  it("连续完成相邻任务：焦点不落到另一个正在离场的任务", async () => {
    const user = userEvent.setup();
    seedList([A, B, C]);
    toggleTask.mockImplementation(async (id: string) =>
      taskFix({ ...(id === "a" ? A : B), status: "completed" }),
    );
    listTasks.mockResolvedValue([C]);
    const exit = controlExitTimers();
    try {
      const { container } = render(<StoreListHarness />);

      await user.click(checkOf(container, "a"));
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('[data-task-id="a"]')?.classList.contains("leaving")).toBe(true);
      await user.click(checkOf(container, "b"));
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('[data-task-id="b"]')?.classList.contains("leaving")).toBe(true);

      // 两次离场都推进到收尾：刷新与焦点移交都在动画结束后发生
      await exit.runAll();
      // 甲乙都在离场，焦点应交给仍在场的丙，而不是正在退场的行
      await waitFor(() => expect(document.activeElement).toBe(checkOf(container, "c")));
      expect(document.activeElement?.closest('[data-task-id="a"]')).toBeNull();
      expect(document.activeElement?.closest('[data-task-id="b"]')).toBeNull();
      await waitFor(() => expect(useTasksStore.getState().exitHolds).toEqual([]));
    } finally {
      exit.restore();
    }
  });

  it("最后一项完成后焦点回退到列表入口控件", async () => {
    const user = userEvent.setup();
    seedList([A]);
    toggleTask.mockResolvedValue(taskFix({ ...A, status: "completed" }));
    listTasks.mockResolvedValue([]);
    const { container } = render(<StoreListHarness />);

    await user.click(checkOf(container, "a"));
    await waitFor(() => expect(container.querySelector('[data-task-id="a"]')).toBeNull());
    expect(document.activeElement).toBe(container.querySelector(".quick-add-input"));
  });

  it("离场期切筛选：旧离场态与快照立即撤销，不跨视图残留", async () => {
    const user = userEvent.setup();
    seedList([A, B]);
    const doneA = taskFix({ ...A, status: "completed" });
    toggleTask.mockResolvedValue(doneA);
    listTasks.mockResolvedValue([doneA]);
    const { container } = render(<StoreListHarness />);

    await user.click(checkOf(container, "a"));
    await waitFor(() => expect(container.querySelector('[data-task-id="a"]')?.classList.contains("leaving")).toBe(true));

    await act(async () => {
      useTasksStore.getState().setFilter({ status: "completed" });
    });
    await waitFor(() => expect(useTasksStore.getState().tasks.every((t) => t.status === "completed")).toBe(true));

    expect(useTasksStore.getState().exitHolds).toEqual([]);
    await waitFor(() =>
      expect(container.querySelector('[data-task-id="a"]')?.classList.contains("leaving")).toBe(false),
    );
    // 离场定时器仍在跑，等它结束后再进入下一用例
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
  });

  it("减少动态：不播离场，焦点仍按相邻任务交接", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    try {
      const user = userEvent.setup();
      seedList([A, B]);
      toggleTask.mockResolvedValue(taskFix({ ...A, status: "completed" }));
      listTasks.mockResolvedValue([B]);
      const { container } = render(<StoreListHarness />);

      await user.click(checkOf(container, "a"));
      await waitFor(() => expect(container.querySelector('[data-task-id="a"]')).toBeNull());
      expect(document.activeElement).toBe(checkOf(container, "b"));
      expect(useTasksStore.getState().exitHolds).toEqual([]);
    } finally {
      window.matchMedia = original;
    }
  });

  it("完成请求在途时切换筛选：成功后不向新视图注入离场快照，也不错误离场", async () => {
    const user = userEvent.setup();
    seedList([A, B]);
    const doneA = taskFix({ ...A, status: "completed" });
    let resolveToggle!: (t: Task) => void;
    toggleTask.mockReturnValue(
      new Promise<Task>((res) => {
        resolveToggle = res;
      }),
    );
    // 新筛选「全部」下 A 已完成，仍然合法地在列表里
    listTasks.mockImplementation(async (f: TaskFilter = {}) =>
      f.status === "all" ? [doneA, B] : [B],
    );
    const { container } = render(<StoreListHarness />);

    await user.click(checkOf(container, "a"));
    // 后端未返回就切到「全部」：新视图先加载出自己的真实结果
    await act(async () => {
      useTasksStore.getState().setFilter({ status: "all" });
    });
    await waitFor(() =>
      expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(["a", "b"]),
    );

    resolveToggle(doneA);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1));

    // 旧请求的成功结果只同步后端状态，不把旧视图的离场快照插进新列表
    expect(useTasksStore.getState().exitHolds).toEqual([]);
    const row = container.querySelector<HTMLElement>('[data-task-id="a"]')!;
    expect(row.classList.contains("leaving")).toBe(false);
    expect(row.hasAttribute("inert")).toBe(false);
    expect(useTasksStore.getState().filter.status).toBe("all");
    expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("TaskItem 元信息行", () => {
  it("无截止时间/提醒/重复/分类/标签/关联时整行不渲染，只有标题的任务卡不多占一行", () => {
    // 守的契约：空 .task-meta 会额外占行高（紧凑视图尤其明显）；
    // 没有元信息时该容器必须完全不存在，而不是渲染空 div。
    seed(PENDING);
    const { container } = render(<TaskItem task={PENDING} />);
    expect(container.querySelector(".task-item")).toBeTruthy();
    expect(container.querySelector(".task-meta")).toBeNull();
  });

  it("有截止时间时渲染元信息行与到期文案", () => {
    // 守的契约：折叠空容器的同时不能误删真实元信息。
    const withDue = taskFix({
      id: "t2",
      title: "交周报",
      due_at: "2026-11-20T09:00:00.000Z",
    });
    seed(withDue);
    const { container } = render(<TaskItem task={withDue} />);
    const meta = container.querySelector(".task-meta");
    expect(meta).toBeTruthy();
    expect(meta!.querySelector(".task-due")).toBeTruthy();
  });
});
