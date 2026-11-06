//! 任务列表异步一致性：旧筛选/旧搜索的响应不得覆盖新视图。
//! 这类竞争只能靠可控 Promise 复现，不依赖真实后端时序。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge")>();
  return {
    ...actual,
    listTasks: vi.fn(),
    createTask: vi.fn(),
    taskStats: vi.fn(async () => ({
      pending: 0,
      overdue: 0,
      due_today: 0,
      completed_today: 0,
      next_due_at: null,
    })),
  };
});

import { listTasks, createTask, type Task, type TaskFilter } from "../lib/bridge";
import { useTasksStore } from "./useTasksStore";
import {
  clientDiagnosticsStats,
  flushDiagnostics,
  setDiagnosticTransport,
  type DiagnosticInput,
} from "../lib/diagnostics";

const listMock = vi.mocked(listTasks);

function taskOf(id: string, status: Task["status"] = "pending"): Task {
  return {
    id,
    title: `任务-${id}`,
    description: "",
    priority: 1,
    status,
    category: "",
    tags: [],
    due_at: null,
    remind_at: null,
    advance_minutes: 0,
    recurrence: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    completed_at: status === "completed" ? "2026-11-01T01:00:00Z" : null,
    linked_agents: 0,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function reset() {
  useTasksStore.setState({
    tasks: [],
    stats: null,
    filter: { view: "all", status: "pending", sort: "due" },
    loading: false,
    error: null,
    statsError: null,
    lite: null,
    liteScope: "all",
    liteTarget: "all",
    liteLoading: false,
    liteError: null,
    exitHolds: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

describe("任务列表请求代际", () => {
  it("旧筛选请求晚到：不覆盖新筛选的列表、筛选条件与 loading", async () => {
    const oldPending = deferred<Task[]>();
    const newCompleted = deferred<Task[]>();
    listMock.mockImplementation((f: TaskFilter = {}) =>
      f.status === "completed" ? newCompleted.promise : oldPending.promise,
    );

    const oldLoad = useTasksStore.getState().load();
    // 用户切到「已完成」：新请求已经在途
    useTasksStore.getState().setFilter({ status: "completed" });

    newCompleted.resolve([taskOf("b1", "completed")]);
    await vi.waitFor(() =>
      expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(["b1"]),
    );

    // 旧「未完成」请求现在才返回
    oldPending.resolve([taskOf("a1")]);
    await oldLoad;
    await new Promise((r) => setTimeout(r, 0));

    const state = useTasksStore.getState();
    expect(state.tasks.map((t) => t.id)).toEqual(["b1"]);
    expect(state.filter.status).toBe("completed");
    expect(state.loading).toBe(false);
  });

  it("旧请求失败晚到：不覆盖新请求的成功结果与错误状态", async () => {
    const oldPending = deferred<Task[]>();
    const newCompleted = deferred<Task[]>();
    listMock.mockImplementation((f: TaskFilter = {}) =>
      f.status === "completed" ? newCompleted.promise : oldPending.promise,
    );

    const oldLoad = useTasksStore.getState().load().catch(() => {});
    useTasksStore.getState().setFilter({ status: "completed" });

    newCompleted.resolve([taskOf("b1", "completed")]);
    await vi.waitFor(() => expect(useTasksStore.getState().error).toBeNull());

    oldPending.reject(new Error("db locked"));
    await oldLoad;
    await new Promise((r) => setTimeout(r, 0));

    const state = useTasksStore.getState();
    expect(state.tasks.map((t) => t.id)).toEqual(["b1"]);
    expect(state.error).toBeNull();
  });

  it("A→B→A 快速切：最后发出的请求先返回也不被更早的响应回滚", async () => {
    const first = deferred<Task[]>();
    const second = deferred<Task[]>();
    const third = deferred<Task[]>();
    listMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);

    useTasksStore.getState().setFilter({ status: "pending" });
    useTasksStore.getState().setFilter({ status: "completed" });
    useTasksStore.getState().setFilter({ status: "pending" });

    // 最后一次请求先返回（真实后端在此条件下可能更快）
    third.resolve([taskOf("a-new")]);
    await vi.waitFor(() =>
      expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(["a-new"]),
    );

    // B 与最初的 A 随后返回，均属于过期代际
    second.resolve([taskOf("b-old", "completed")]);
    first.resolve([taskOf("a-old")]);
    await new Promise((r) => setTimeout(r, 0));

    const state = useTasksStore.getState();
    expect(state.tasks.map((t) => t.id)).toEqual(["a-new"]);
    expect(state.filter.status).toBe("pending");
  });

  it("搜索词连续变化：只认最后一次查询结果", async () => {
    const req = new Map<string, ReturnType<typeof deferred<Task[]>>>();
    listMock.mockImplementation((f: TaskFilter = {}) => {
      const key = f.search ?? "";
      const d = deferred<Task[]>();
      req.set(key, d);
      return d.promise;
    });

    useTasksStore.getState().setFilter({ search: "牛" });
    useTasksStore.getState().setFilter({ search: "牛奶" });
    useTasksStore.getState().setFilter({ search: "牛奶x" });

    req.get("牛奶x")!.resolve([taskOf("t-new")]);
    req.get("牛奶")!.resolve([taskOf("t-mid")]);
    req.get("牛")!.resolve([taskOf("t-old")]);
    await new Promise((r) => setTimeout(r, 0));

    const state = useTasksStore.getState();
    expect(state.tasks.map((t) => t.id)).toEqual(["t-new"]);
    expect(state.filter.search).toBe("牛奶x");
  });

  it("后台刷新与手动切筛选并发：手动切换的新结果不被旧刷新覆盖", async () => {
    const refreshReq = deferred<Task[]>();
    const switchReq = deferred<Task[]>();
    listMock.mockImplementation((f: TaskFilter = {}) =>
      f.status === "completed" ? switchReq.promise : refreshReq.promise,
    );

    // 后台刷新（旧筛选）在途时用户切到「已完成」
    const refreshP = useTasksStore.getState().refresh();
    useTasksStore.getState().setFilter({ status: "completed" });

    switchReq.resolve([taskOf("b1", "completed")]);
    await vi.waitFor(() =>
      expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(["b1"]),
    );

    refreshReq.resolve([taskOf("a-stale")]);
    await refreshP;
    await new Promise((r) => setTimeout(r, 0));

    expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(["b1"]);
    expect(useTasksStore.getState().filter.status).toBe("completed");
  });

  it("离场快照与列表加载同时发生：加载不清掉动画中的快照，切筛选才清", async () => {
    useTasksStore.getState().holdForExit(taskOf("a"), 1, "b", 42);
    const req = deferred<Task[]>();
    listMock.mockImplementation(() => req.promise);
    const loadP = useTasksStore.getState().load();
    req.resolve([taskOf("b")]);
    await loadP;

    expect(useTasksStore.getState().exitHolds).toHaveLength(1);
    useTasksStore.getState().setFilter({ status: "all" });
    expect(useTasksStore.getState().exitHolds).toEqual([]);
  });

  it("同一任务先后两次登记：先结束的旧动画不能释放后登记的快照", () => {
    const first = useTasksStore.getState().holdForExit(taskOf("a"), 0, null, 40);
    const second = useTasksStore.getState().holdForExit(taskOf("a"), 0, null, 50);
    expect(useTasksStore.getState().exitHolds).toHaveLength(1);
    useTasksStore.getState().releaseExitHold("a", first);
    expect(useTasksStore.getState().exitHolds).toHaveLength(1);
    useTasksStore.getState().releaseExitHold("a", second);
    expect(useTasksStore.getState().exitHolds).toEqual([]);
  });
});

describe("任务保存操作链", () => {
  it("create 失败：错误原样抛出，诊断终态携带 persist 阶段且不含标题", async () => {
    vi.mocked(createTask).mockRejectedValueOnce({ code: "IO_ERROR", message: "写入失败" });
    // 先清空此前用例留下的诊断队列，避免旧事件混入本次断言。
    setDiagnosticTransport(async () => {});
    while (clientDiagnosticsStats().queued > 0) await flushDiagnostics();

    const events: DiagnosticInput[] = [];
    setDiagnosticTransport(async (batch) => {
      events.push(...batch);
    });
    try {
      await expect(
        useTasksStore.getState().create({ title: "不应出现在日志里的标题" }),
      ).rejects.toMatchObject({ code: "IO_ERROR" });
      while (clientDiagnosticsStats().queued > 0) await flushDiagnostics();

      const opEvents = events.filter((event) => event.action === "create_task");
      expect(opEvents.filter((event) => event.status === "started")).toHaveLength(1);
      const failed = opEvents.find((event) => event.status === "failed");
      expect(failed).toMatchObject({ stage: "persist", error_code: "IO_ERROR" });
      expect(JSON.stringify(opEvents)).not.toContain("不应出现在日志里的标题");
    } finally {
      setDiagnosticTransport(null);
    }
  });
});
