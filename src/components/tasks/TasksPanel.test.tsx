/**
 * @vitest-environment jsdom
 */
//! TasksPanel 真实 DOM 交互测试：搜索框输入与状态筛选点击 → store.setFilter →
//! bridge listTasks 重查 → 任务列表更新。
//!
//! bridge mock：listTasks 按内存 fixture 过滤（模拟后端查询），taskStats 返回固定值；
//! store 用真实实例（走真实 setFilter → load 链路）。fixtures 放在 vi.hoisted 里，
//! 因为 vi.mock 工厂会被提升到模块顶部执行。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useTasksStore } from "../../store/useTasksStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import TasksPanel from "./TasksPanel";
import { listTasks, toggleTask } from "../../lib/bridge";
import type { Task, TaskFilter } from "../../lib/bridge";
import { EXIT_MS } from "../../lib/motion";

const { ALL_TASKS, filterTasks } = vi.hoisted(() => {
  function taskFix(p: Partial<Task> & Pick<Task, "id" | "title">): Task {
    return {
      description: "",
      priority: 1,
      status: "pending",
      category: "",
      tags: [],
      due_at: null,
      remind_at: null,
      advance_minutes: 0,
      recurrence: null,
      created_at: "2026-10-27T00:00:00Z",
      updated_at: "2026-10-27T00:00:00Z",
      completed_at: null,
      linked_agents: 0,
      ...p,
    };
  }
  const ALL_TASKS: Task[] = [
    taskFix({ id: "a", title: "买牛奶", due_at: "2026-10-28T09:00:00.000Z" }),
    taskFix({ id: "b", title: "写代码", due_at: "2026-10-29T09:00:00.000Z" }),
    taskFix({ id: "c", title: "旧任务", status: "completed", completed_at: "2026-10-27T00:00:00Z" }),
  ];
  /** 模拟后端 list_tasks：按 search / status / overdue 视图过滤（其余维度与本测试无关）。 */
  const filterTasks = (f: TaskFilter): Task[] => {
    let list = ALL_TASKS;
    if (f.search?.trim()) list = list.filter((t) => t.title.includes(f.search!.trim()));
    if (f.status && f.status !== "all") list = list.filter((t) => t.status === f.status);
    // 与后端 `list_tasks` 的 overdue 语义一致：有截止时间、早于当前、且仍未完成
    if (f.view === "overdue") {
      list = list.filter(
        (t) => t.status === "pending" && !!t.due_at && new Date(t.due_at).getTime() < Date.now(),
      );
    }
    return list;
  };
  return { ALL_TASKS, filterTasks };
});

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    listTasks: vi.fn(async (f: TaskFilter) => filterTasks(f)),
    toggleTask: vi.fn(),
    taskStats: vi.fn(async () => ({
      pending: 2,
      overdue: 0,
      due_today: 1,
      completed_today: 0,
      next_due_at: null,
    })),
    parseQuickAdd: vi.fn(),
    createFromQuickAdd: vi.fn(),
    listTaskLinks: vi.fn(async () => []),
    clipboardTaskLinks: vi.fn(async () => []),
  };
});

vi.mock("../../lib/navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/navigation")>(),
  navTaskTargets: vi.fn(async () => []),
}));

vi.mock("./analytics/TaskAnalyticsPanel", () => ({
  default: () => <div>analytics-panel</div>,
}));

function seedTasks() {
  useTasksStore.setState({
    tasks: ALL_TASKS,
    loading: false,
    stats: { pending: 2, overdue: 0, due_today: 1, completed_today: 0, next_due_at: null },
    filter: { view: "all", status: "all", sort: "due" },
    exitHolds: [],
  });
  useNavigationStore.setState({ linksByTask: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ editor: { open: false, task: null } });
  // jsdom 的 requestAnimationFrame 兜底（搜索按钮展开后用 rAF 聚焦输入框）
  vi.stubGlobal(
    "requestAnimationFrame",
    (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TasksPanel 筛选交互", () => {
  it("上下文帮助打开对应教程，不修改当前任务筛选", async () => {
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);
    const currentFilter = useTasksStore.getState().filter;

    await user.click(screen.getByRole("button", { name: "查看帮助：创建任务与自然语言提醒" }));
    await user.click(await screen.findByRole("button", { name: "查看完整教程" }));

    expect(useUiStore.getState().tab).toBe("help");
    expect(useUiStore.getState().helpOpenRequest?.articleId).toBe("help.tasks.create-reminders");
    expect(useTasksStore.getState().filter).toEqual(currentFilter);
  });

  it("点击搜索按钮展开输入框，输入关键词过滤任务列表", async () => {
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);

    expect(screen.getByText("买牛奶")).toBeTruthy();
    expect(screen.getByText("写代码")).toBeTruthy();
    expect(screen.getByText("旧任务")).toBeTruthy();

    const searchInput = await screen.findByPlaceholderText(/搜索标题/);
    await user.type(searchInput, "牛奶");

    await waitFor(() => expect(screen.queryByText("写代码")).toBeNull());
    expect(screen.queryByText("旧任务")).toBeNull();
    expect(screen.getByText("买牛奶")).toBeTruthy();
    expect(useTasksStore.getState().filter.search).toBe("牛奶");
  });

  it("搜索框与筛选条位于列表滚动容器之外（页头固定）", async () => {
    seedTasks();
    render(<TasksPanel />);

    const searchInput = await screen.findByPlaceholderText(/搜索标题/);
    const list = document.querySelector(".task-list")!;
    expect(list).toBeTruthy();
    expect(list.contains(searchInput)).toBe(false);
    expect(list.contains(document.querySelector(".filter-bar.primary"))).toBe(false);
    expect(list.contains(document.querySelector(".filter-bar.secondary"))).toBe(false);
    expect(list.contains(document.querySelector(".tasks-overview"))).toBe(false);
  });

  it("清空搜索恢复全部；点击状态按钮过滤任务列表", async () => {
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);

    // 过滤
    await user.type(await screen.findByPlaceholderText(/搜索标题/), "牛奶");
    await waitFor(() => expect(screen.queryByText("写代码")).toBeNull());

    // 清空搜索 → 三条全部回来
    await user.click(await screen.findByRole("button", { name: "清空搜索" }));
    await waitFor(() => expect(screen.getByText("写代码")).toBeTruthy());
    expect(screen.getByText("旧任务")).toBeTruthy();

    // 状态筛选：已完成 → 只剩"旧任务"
    await user.click(screen.getByRole("button", { name: "已完成" }));
    await waitFor(() => expect(screen.queryByText("买牛奶")).toBeNull());
    expect(screen.queryByText("写代码")).toBeNull();
    expect(screen.getByText("旧任务")).toBeTruthy();
    expect(useTasksStore.getState().filter.status).toBe("completed");
  });

  it("读取失败显示真实错误与重试，不伪装成「暂无任务」", () => {
    useTasksStore.setState({
      tasks: [],
      loading: false,
      error: "数据库操作失败",
      stats: null,
      filter: { view: "all", status: "all", sort: "due" },
    });
    render(<TasksPanel />);

    expect(screen.getByText("任务读取失败")).toBeTruthy();
    expect(screen.getByText(/数据库操作失败/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    // 空状态文案不能被当成正常无任务展示
    expect(screen.queryByText("这里还很清爽")).toBeNull();
  });

  it("列表刷新失败但仍有旧数据时：保留任务并标记数据可能过期", () => {
    useTasksStore.setState({
      tasks: ALL_TASKS,
      loading: false,
      error: "网络超时",
      stats: null,
      filter: { view: "all", status: "all", sort: "due" },
    });
    render(<TasksPanel />);

    expect(screen.getByText("买牛奶")).toBeTruthy();
    expect(screen.getByText(/列表刷新失败/)).toBeTruthy();
    expect(screen.queryByText("任务读取失败")).toBeNull();
  });

  it("「统计」入口切换到任务统计子视图，可再次点击或 Escape 关闭", async () => {
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);

    await user.click(screen.getByRole("button", { name: "任务统计" }));
    expect(screen.getByText("analytics-panel")).toBeTruthy();
    // 列表被统计视图替换，不并存
    expect(screen.queryByText("买牛奶")).toBeNull();

    await user.click(screen.getByRole("button", { name: "返回任务列表" }));
    expect(screen.getByText("买牛奶")).toBeTruthy();
    expect(screen.queryByText("analytics-panel")).toBeNull();

    // Escape 关闭统计子视图
    await user.click(screen.getByRole("button", { name: "任务统计" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("analytics-panel")).toBeNull());
    expect(screen.getByText("买牛奶")).toBeTruthy();
  });

  it("任务编辑态在主内容区切换：返回列表恢复筛选与滚动位置，不新开窗口", async () => {
    const user = userEvent.setup();
    seedTasks();
    render(<TasksPanel />);

    // 先进入一个筛选状态，作为"返回后必须保留"的前置条件
    await user.type(await screen.findByPlaceholderText(/搜索标题/), "牛奶");
    await waitFor(() => expect(screen.queryByText("写代码")).toBeNull());

    // 列表是独立滚动容器（页头与搜索框固定，不随列表滚动）
    const list = document.querySelector<HTMLElement>(".task-list")!;
    list.scrollTop = 120;
    fireEvent.scroll(list);

    act(() => {
      useUiStore.setState({ editor: { open: true, task: ALL_TASKS[0] } });
    });

    // 主内容区切换：列表让位给编辑态，没有模态遮罩
    expect(screen.getByText("编辑任务")).toBeTruthy();
    expect(screen.queryByText("买牛奶")).toBeNull();
    expect(document.querySelector(".modal-mask")).toBeNull();

    await user.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByText("编辑任务")).toBeNull());
    expect(screen.getByText("买牛奶")).toBeTruthy();
    expect(screen.queryByText("写代码")).toBeNull();
    expect(useTasksStore.getState().filter.search).toBe("牛奶");
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>(".task-list")!.scrollTop).toBe(120),
    );
  });
});

describe("任务离场与后台刷新", () => {
  const doneA: Task = {
    ...ALL_TASKS[0],
    status: "completed",
    completed_at: "2026-10-27T10:00:00Z",
  };

  function seedPending() {
    useTasksStore.setState({
      tasks: [ALL_TASKS[0], ALL_TASKS[1]],
      loading: false,
      error: null,
      filter: { view: "all", status: "pending", sort: "due" },
      exitHolds: [],
    });
  }

  function row(container: HTMLElement, id: string) {
    return container.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
  }

  beforeEach(() => {
    vi.mocked(listTasks).mockImplementation(async (f: TaskFilter = {}) => filterTasks(f));
  });

  it("离场期间后台 refresh：真实列表已更新，离场行不提前消失也不重复", async () => {
    const user = userEvent.setup();
    seedPending();
    vi.mocked(toggleTask).mockResolvedValue(doneA);
    const renamedB = { ...ALL_TASKS[1], title: "写代码·改" };
    // 后台刷新（其他模块触发）：后端真实结果不含已完成的 a
    vi.mocked(listTasks).mockResolvedValue([renamedB]);

    // 离场动画的 190ms 计时器由本用例手动推进：机器负载高时真实计时器可能在
    // 「刷新完成 → 中间态断言」之间就到期，把要断言的离场行提前移除。
    // 只接管恰好 EXIT_MS 的定时器，其余（userEvent / waitFor 的）照常走真实时间。
    const pendingExitTimers: Array<() => void> = [];
    const realSetTimeout = window.setTimeout.bind(window);
    const timerSpy = vi
      .spyOn(window, "setTimeout")
      .mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === EXIT_MS && typeof handler === "function") {
          pendingExitTimers.push(() => (handler as (...rest: unknown[]) => void)(...args));
          return 0 as unknown as number;
        }
        return realSetTimeout(handler, timeout, ...args);
      }) as typeof window.setTimeout);

    try {
      const { container } = render(<TasksPanel />);

      await user.click(row(container, "a")!.querySelector(".task-check")!);
      await waitFor(() => expect(row(container, "a")).not.toBeNull());
      await waitFor(() => expect(row(container, "a")!.classList.contains("leaving")).toBe(true));
      expect(pendingExitTimers).toHaveLength(1);

      await act(async () => {
        await useTasksStore.getState().refresh();
      });
      // 后端真实数据已经更新：a 不在列表里，b 的新标题已生效
      expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(["b"]);
      expect(screen.getByText("写代码·改")).toBeTruthy();

      // 离场行仍由快照补渲染（只一张卡），保持隔离，等动画播完再移除
      expect(row(container, "a")).not.toBeNull();
      expect(row(container, "a")!.classList.contains("leaving")).toBe(true);
      expect(row(container, "a")!.hasAttribute("inert")).toBe(true);
      expect(container.querySelectorAll('[data-task-id="a"]')).toHaveLength(1);

      // 动画结束：快照释放，行移除
      await act(async () => {
        pendingExitTimers.splice(0).forEach((run) => run());
      });
      await waitFor(() => expect(row(container, "a")).toBeNull());
      expect(useTasksStore.getState().exitHolds).toEqual([]);
    } finally {
      timerSpy.mockRestore();
    }
  });

  it("离场期间点 Toast 撤销：后端恢复未完成，行在动画结束后仍可见可操作", async () => {
    const user = userEvent.setup();
    seedPending();
    const pendingA: Task = { ...ALL_TASKS[0], status: "pending" };
    vi.mocked(toggleTask).mockResolvedValueOnce(doneA).mockResolvedValueOnce(pendingA);
    // 完成后的真实列表：只剩 b
    vi.mocked(listTasks).mockResolvedValue([ALL_TASKS[1]]);
    const { container } = render(<TasksPanel />);

    await user.click(row(container, "a")!.querySelector(".task-check")!);
    await waitFor(() => expect(row(container, "a")!.classList.contains("leaving")).toBe(true));

    // 撤销：真实后端 toggle 回未完成，并重查列表
    vi.mocked(listTasks).mockResolvedValue([ALL_TASKS[0], ALL_TASKS[1]]);
    await act(async () => {
      await useUiStore.getState().toast!.action!.run();
    });
    await waitFor(() =>
      expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(["a", "b"]),
    );

    // 原离场动画收尾后不能把已恢复的任务藏死
    await waitFor(() => expect(useTasksStore.getState().exitHolds).toEqual([]));
    await waitFor(() => {
      const r = row(container, "a");
      expect(r).not.toBeNull();
      expect(r!.classList.contains("leaving")).toBe(false);
      expect(r!.querySelector(".task-check")!.hasAttribute("disabled")).toBe(false);
    });
    // 后端只有一条 a，没有因快照/刷新产生重复卡
    expect(container.querySelectorAll('[data-task-id="a"]')).toHaveLength(1);
  });

  it("离场期切筛选：旧视图快照清空，新视图不残留离场行", async () => {
    const user = userEvent.setup();
    seedPending();
    vi.mocked(toggleTask).mockResolvedValue(doneA);
    vi.mocked(listTasks).mockResolvedValue([ALL_TASKS[1]]);
    const { container } = render(<TasksPanel />);

    await user.click(row(container, "a")!.querySelector(".task-check")!);
    await waitFor(() => expect(row(container, "a")!.classList.contains("leaving")).toBe(true));

    // 切到「已完成」：新视图的数据由后端返回
    vi.mocked(listTasks).mockResolvedValue([ALL_TASKS[2]]);
    await act(async () => {
      useTasksStore.getState().setFilter({ status: "completed" });
    });
    await waitFor(() => expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(["c"]));

    expect(useTasksStore.getState().exitHolds).toEqual([]);
    expect(row(container, "a")).toBeNull();
    expect(screen.getByText("旧任务")).toBeTruthy();
  });

  it("动画期卸载：不留悬空快照与未释放状态", async () => {
    const user = userEvent.setup();
    seedPending();
    // 用可控 Promise 卡住写入结果：点击后先停在「已提交、动画未开始」，
    // 手动 resolve 后才进入离场态。避免依赖 190ms 动画窗口与 waitFor 轮询的时序，
    // 并行跑多个测试文件时也不会因调度延迟错过 leaving 状态。
    let resolveToggle!: (task: Task) => void;
    vi.mocked(toggleTask).mockImplementationOnce(
      () =>
        new Promise<Task>((resolve) => {
          resolveToggle = resolve;
        }),
    );
    // 本用例只验证「卸载时释放离场快照」，不模拟「完成后服务端列表已不含 a」：
    // 若让任何一次后台刷新在写入返回前抽走目标行，行组件会先卸载、ref 归空，
    // 离场快照根本不会建立，断言会因无关的后台刷新时序而随机失败。
    vi.mocked(listTasks).mockResolvedValue([ALL_TASKS[0], ALL_TASKS[1]]);
    const { container, unmount } = render(<TasksPanel />);

    await user.click(row(container, "a")!.querySelector(".task-check")!);
    await act(async () => {
      await Promise.resolve();
    });
    // 先确认点击确实走到写入（否则 resolveToggle 未赋值，失败原因会被误报成空指针）
    await waitFor(() => expect(vi.mocked(toggleTask)).toHaveBeenCalled());
    await act(async () => {
      resolveToggle(doneA);
    });
    expect(row(container, "a")!.classList.contains("leaving")).toBe(true);
    expect(useTasksStore.getState().exitHolds.map((h) => h.task.id)).toEqual(["a"]);

    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(useTasksStore.getState().exitHolds).toEqual([]);
  });
});

describe("统计卡逾期入口", () => {
  it("点击逾期卡：切到 overdue 视图，保留状态/搜索/排序，展示数据全部符合逾期条件", async () => {
    const user = userEvent.setup();
    // 前面的离场用例会把 listTasks 改成固定返回值；本用例按筛选语义重新接管
    vi.mocked(listTasks).mockImplementation(async (f: TaskFilter = {}) => filterTasks(f));
    seedTasks();
    render(<TasksPanel />);

    // 先构造非默认筛选条件，验证切视图时不被重置
    await user.type(await screen.findByPlaceholderText(/搜索标题/), "牛奶");
    await user.click(screen.getByRole("button", { name: "未完成" }));
    await waitFor(() => expect(useTasksStore.getState().filter.search).toBe("牛奶"));

    const list = document.querySelector<HTMLElement>(".task-list")!;
    list.scrollTop = 80;
    fireEvent.scroll(list);

    // 点击前记录筛选状态
    const before = useTasksStore.getState().filter;
    expect(before).toEqual({ view: "all", status: "pending", sort: "due", search: "牛奶" });

    const card = document.querySelectorAll(".overview-card")[2] as HTMLElement;
    await user.click(card);

    // 视图切换为逾期，其余条件原样保留
    await waitFor(() => expect(useTasksStore.getState().filter.view).toBe("overdue"));
    const after = useTasksStore.getState().filter;
    expect(after.status).toBe(before.status);
    expect(after.sort).toBe(before.sort);
    expect(after.search).toBe(before.search);
    expect(vi.mocked(listTasks)).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "overdue", status: "pending", sort: "due", search: "牛奶" }),
    );

    // 展示数据逐条符合逾期语义（不拿列表数量当通过依据）
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".task-item[data-task-id]"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const task = ALL_TASKS.find((t) => t.id === row.dataset.taskId)!;
      expect(task.status).toBe("pending");
      expect(task.due_at).not.toBeNull();
      expect(new Date(task.due_at!).getTime()).toBeLessThan(Date.now());
    }
    expect(rows.map((r) => r.dataset.taskId)).toEqual(["a"]);

    // 点击后焦点留在逾期卡上，列表滚动位置未被改动
    expect(document.activeElement).toBe(card);
    expect(document.querySelector<HTMLElement>(".task-list")!.scrollTop).toBe(80);
  });

  it("逾期卡支持 Enter 与 Space 激活（Space 阻止页面滚动），行为与点击一致", async () => {
    seedTasks();
    render(<TasksPanel />);
    const card = document.querySelectorAll(".overview-card")[2] as HTMLElement;

    card.focus();
    expect(document.activeElement).toBe(card);

    fireEvent.keyDown(card, { key: "Enter" });
    await waitFor(() => expect(useTasksStore.getState().filter.view).toBe("overdue"));

    act(() => {
      useTasksStore.getState().setFilter({ view: "all" });
    });
    await waitFor(() => expect(useTasksStore.getState().filter.view).toBe("all"));

    card.focus();
    // fireEvent 返回 false 代表 keydown 已被 preventDefault（Space 不会滚动内容区）
    expect(fireEvent.keyDown(card, { key: " " })).toBe(false);
    await waitFor(() => expect(useTasksStore.getState().filter.view).toBe("overdue"));
    expect(document.activeElement).toBe(card);
  });
});

describe("任务页统计概览", () => {
  it("三卡只保留「数值 + 标签」，不重复绘制图标", () => {
    seedTasks();
    render(<TasksPanel />);

    const cards = document.querySelectorAll(".overview-card");
    expect(cards).toHaveLength(3);
    cards.forEach((card) => {
      // 图标与标签语义重复，卡内不再绘制 svg
      expect(card.querySelector("svg")).toBeNull();
      const value = card.querySelector(".overview-value");
      const label = card.querySelector(".overview-label");
      expect(value?.textContent).toBeTruthy();
      expect(label?.textContent).toBeTruthy();
      // 数字在左、标签在右
      expect(
        value!.compareDocumentPosition(label!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  it("三张统计卡都可点击下钻到对应筛选（待完成 / 今日到期 / 逾期）", () => {
    seedTasks();
    render(<TasksPanel />);
    const cards = document.querySelectorAll<HTMLElement>(".overview-card");

    fireEvent.click(cards[0]);
    expect(useTasksStore.getState().filter).toMatchObject({ view: "all", status: "pending" });

    fireEvent.click(cards[1]);
    expect(useTasksStore.getState().filter).toMatchObject({ view: "today", status: "pending" });

    fireEvent.click(cards[2]);
    expect(useTasksStore.getState().filter).toMatchObject({ view: "overdue" });

    // 键盘契约：Enter 同样可激活
    fireEvent.keyDown(cards[0], { key: "Enter" });
    expect(useTasksStore.getState().filter).toMatchObject({ view: "all", status: "pending" });
  });

  it("逾期为 0 不加警告强调，>0 才标记", () => {
    seedTasks();
    render(<TasksPanel />);
    expect(document.querySelectorAll(".overview-card")[2].classList.contains("warn")).toBe(false);

    act(() => {
      useTasksStore.setState({
        stats: { pending: 2, overdue: 3, due_today: 1, completed_today: 0, next_due_at: null },
      });
    });
    expect(document.querySelectorAll(".overview-card")[2].classList.contains("warn")).toBe(true);
  });
});
