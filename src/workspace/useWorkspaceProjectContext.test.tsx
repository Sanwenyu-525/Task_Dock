//! P0-03 项目上下文竞态测试（2026-11-13）。
//!
//! 用「延迟响应 + 乱序兑现」模拟真实竞态，逐条覆盖验收要求的场景：
//! A→B 快速切换、A→B→A、A 慢于 B、A 失败 B 成功、B 失败但 A 曾成功、
//! 切换期间写事项、事项归属校验、切换/删除后的状态隔离。
//!
//! 这些断言只证明**前端不再被过期响应污染**；后端按 projectId 的归属约束
//! 由 Rust 侧测试保证（前端防竞态不是后端权限的替代品）。

// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  workspaceInstanceGet: vi.fn(),
  workspaceInstanceSave: vi.fn(),
  workspaceItemList: vi.fn(),
  workspaceItemSave: vi.fn(),
  workspaceItemDelete: vi.fn(),
  workspaceTaskLinkList: vi.fn(),
  workspaceTaskLinkAdd: vi.fn(),
  workspaceTaskUnlink: vi.fn(),
  listTasks: vi.fn(),
  devProjectList: vi.fn(),
  devProjectProbe: vi.fn(),
}));

vi.mock("../lib/bridge", () => bridge);

import {
  TASK_PICKER_MAX_LIMIT,
  TASK_PICKER_PAGE_SIZE,
  useWorkspaceDevContext,
  useWorkspaceProjectContext,
  useWorkspaceTaskPicker,
} from "./useWorkspaceProjectContext";
import { WORKSPACE_PROFILES } from "./workspaceProfiles";

const DEV = WORKSPACE_PROFILES.development;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (r?: unknown) => void;
  const state: Deferred<T> = {
    promise: new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    settled: false,
    resolve: (v: T) => {
      state.settled = true;
      resolve(v);
    },
    reject: (r?: unknown) => {
      state.settled = true;
      reject(r);
    },
  };
  return state;
}

/** 每项目一组挂起响应：读取顺序完全由测试控制。 */
interface Bucket {
  inst: Deferred<{ instance: unknown }>;
  items: Deferred<{ items: unknown[] }>;
  links: Deferred<{ links: unknown[] }>;
}

let buckets: Map<string, Bucket>;

function bucketFor(pid: string): Bucket {
  const existing = buckets.get(pid);
  if (existing) return existing;
  const b = {
    inst: deferred<{ instance: unknown }>(),
    items: deferred<{ items: unknown[] }>(),
    links: deferred<{ links: unknown[] }>(),
  };
  buckets.set(pid, b);
  return b;
}

const instanceRow = (pid: string, layoutJson = "") => ({
  projectId: pid,
  activeModule: "overview",
  layoutJson,
  lastOpenedAt: null,
});

const itemRow = (pid: string, title: string, id = `${pid}-${title}`) => ({
  id,
  projectId: pid,
  parentId: null,
  title,
  stage: "",
  status: "todo",
  sortOrder: 0,
  metadataJson: "{}",
  createdAt: "",
  updatedAt: "",
});

const linkRow = (pid: string, taskId: string) => ({
  projectId: pid,
  taskId,
  title: `任务-${taskId}`,
  status: "pending",
  priority: 0,
  dueAt: null,
  createdAt: "",
});

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function resolveBucket(pid: string, items: unknown[], links: unknown[] = []): void {
  const b = bucketFor(pid);
  b.inst.resolve({ instance: instanceRow(pid) });
  b.items.resolve({ items });
  b.links.resolve({ links });
}

beforeEach(() => {
  buckets = new Map();
  vi.clearAllMocks();
  const impl = (kind: keyof Bucket) => (pid: string) => bucketFor(pid)[kind].promise;
  bridge.workspaceInstanceGet.mockImplementation(impl("inst") as never);
  bridge.workspaceItemList.mockImplementation(impl("items") as never);
  bridge.workspaceTaskLinkList.mockImplementation(impl("links") as never);
  bridge.workspaceInstanceSave.mockResolvedValue({ instance: instanceRow("x") });
  bridge.workspaceItemSave.mockResolvedValue({ item: itemRow("x", "t") });
  bridge.workspaceItemDelete.mockResolvedValue({ ok: true });
  bridge.workspaceTaskLinkAdd.mockResolvedValue({ ok: true });
  bridge.workspaceTaskUnlink.mockResolvedValue({ ok: true });
  bridge.listTasks.mockResolvedValue([]);
  bridge.devProjectList.mockResolvedValue({ projects: [] });
  bridge.devProjectProbe.mockResolvedValue({ status: "ok" });
});

describe("useWorkspaceProjectContext：项目切换不串数据", () => {
  it("A→B 快速切换：A 的迟到响应不得覆盖 B", async () => {
    const { result, rerender } = renderHook(
      ({ pid }: { pid: string }) => useWorkspaceProjectContext(pid, DEV),
      { initialProps: { pid: "A" } },
    );

    // 切到 B（A 的请求仍挂起）
    rerender({ pid: "B" });
    expect(result.current.items).toEqual([]); // 立即清空，避免旧内容短暂挂在新项目名下
    expect(result.current.status).toBe("loading");

    // B 先返回
    await act(async () => {
      resolveBucket("B", [itemRow("B", "B-事项")], [linkRow("B", "t-b")]);
      await flush();
    });
    expect(result.current.projectId).toBe("B");
    expect(result.current.items.map((i) => i.title)).toEqual(["B-事项"]);

    // A 的响应迟到
    await act(async () => {
      resolveBucket("A", [itemRow("A", "A-事项")], []);
      await flush();
    });
    expect(result.current.projectId).toBe("B");
    expect(result.current.items.map((i) => i.title)).toEqual(["B-事项"]);
    expect(result.current.links.map((l) => l.taskId)).toEqual(["t-b"]);
  });

  it("A→B→A：回到 A 后只接受第二次 A 请求的结果", async () => {
    const { result, rerender } = renderHook(
      ({ pid }: { pid: string }) => useWorkspaceProjectContext(pid, DEV),
      { initialProps: { pid: "A" } },
    );

    await act(async () => {
      resolveBucket("A", [itemRow("A", "A1")], []);
      await flush();
    });
    expect(result.current.items.map((i) => i.title)).toEqual(["A1"]);

    rerender({ pid: "B" });
    expect(result.current.items).toEqual([]);

    // 回到 A：第一轮的 bucket 已被替换，代表第二次请求
    buckets.delete("A");
    rerender({ pid: "A" });
    expect(result.current.items).toEqual([]);

    await act(async () => {
      resolveBucket("A", [itemRow("A", "A2")], []);
      await flush();
    });
    expect(result.current.items.map((i) => i.title)).toEqual(["A2"]);
  });

  it("A 请求失败但 B 成功：错误不得清空 B 数据", async () => {
    const { result, rerender } = renderHook(
      ({ pid }: { pid: string }) => useWorkspaceProjectContext(pid, DEV),
      { initialProps: { pid: "A" } },
    );
    rerender({ pid: "B" });
    await act(async () => {
      resolveBucket("B", [itemRow("B", "B-事项")], []);
      await flush();
    });
    await act(async () => {
      bucketFor("A").inst.reject(new Error("A 读取失败"));
      await flush();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.items.map((i) => i.title)).toEqual(["B-事项"]);
  });

  it("B 读取失败：不回退显示 A 的数据", async () => {
    const { result, rerender } = renderHook(
      ({ pid }: { pid: string }) => useWorkspaceProjectContext(pid, DEV),
      { initialProps: { pid: "A" } },
    );
    await act(async () => {
      resolveBucket("A", [itemRow("A", "A-事项")], []);
      await flush();
    });
    rerender({ pid: "B" });
    await act(async () => {
      bucketFor("B").inst.reject(new Error("B 读取失败"));
      await flush();
    });
    expect(result.current.projectId).toBe("B");
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("B 读取失败");
    expect(result.current.items).toEqual([]); // 绝不拿 A 的数据顶替
  });

  it("项目清空（删除当前项目）后回到 idle，不保留上一项目内容", async () => {
    const { result, rerender } = renderHook(
      ({ pid }: { pid: string | null }) => useWorkspaceProjectContext(pid, DEV),
      { initialProps: { pid: "A" as string | null } },
    );
    await act(async () => {
      resolveBucket("A", [itemRow("A", "A-事项")], []);
      await flush();
    });
    rerender({ pid: null });
    expect(result.current.status).toBe("idle");
    expect(result.current.items).toEqual([]);
    expect(result.current.links).toEqual([]);
  });

  it("切换期间写事项：结果不刷新到新项目，并如实提示", async () => {
    const { result, rerender } = renderHook(
      ({ pid }: { pid: string }) => useWorkspaceProjectContext(pid, DEV),
      { initialProps: { pid: "A" } },
    );
    await act(async () => {
      resolveBucket("A", [itemRow("A", "A-事项")], []);
      await flush();
    });

    let save!: Deferred<unknown>;
    bridge.workspaceItemSave.mockImplementation(() => {
      save = deferred<unknown>();
      return save.promise as never;
    });

    let pendingResult: Promise<string> | undefined;
    act(() => {
      pendingResult = result.current.addItem({ title: "新事项", stage: "" });
    });

    rerender({ pid: "B" });
    await act(async () => {
      resolveBucket("B", [itemRow("B", "B-事项")], []);
      await flush();
    });

    await act(async () => {
      save.resolve({ item: itemRow("A", "新事项") });
      const outcome = await pendingResult!;
      expect(outcome).toBe("stale");
      await flush();
    });

    expect(result.current.projectId).toBe("B");
    expect(result.current.items.map((i) => i.title)).toEqual(["B-事项"]);
    expect(result.current.lastStaleNotice).toContain("原项目");
    // 没有用 B 的项目 ID 再发写请求
    expect(bridge.workspaceItemSave).toHaveBeenCalledTimes(1);
    expect((bridge.workspaceItemSave.mock.calls[0][0] as { projectId: string }).projectId).toBe("A");
  });

  it("事项归属校验：切走后点击旧事项不得写入新项目", async () => {
    const { result } = renderHook(
      ({ pid }: { pid: string }) => useWorkspaceProjectContext(pid, DEV),
      { initialProps: { pid: "B" } },
    );
    await act(async () => {
      resolveBucket("B", [], []);
      await flush();
    });
    const foreign = itemRow("A", "A-事项");
    const outcome = await result.current.cycleItemStatus(foreign as never);
    expect(outcome).toBe("stale");
    expect(bridge.workspaceItemSave).not.toHaveBeenCalled();
  });
});

describe("useWorkspaceProjectContext：布局持久化（P1-02 7.1）", () => {
  it("切换模块保留 moduleOrder / hiddenModules，不再写 \"{}\"", async () => {
    const layoutJson = JSON.stringify({
      version: 1,
      moduleOrder: ["items", "overview", "settings"],
      hiddenModules: ["links"],
      activeModule: "overview",
    });
    bridge.workspaceInstanceGet.mockResolvedValueOnce({ instance: instanceRow("A", layoutJson) } as never);
    const { result } = renderHook(() => useWorkspaceProjectContext("A", DEV));
    await act(async () => {
      resolveBucket("A", [], []);
      await flush();
    });

    await act(async () => {
      await result.current.saveModule("settings");
      await flush();
    });

    expect(bridge.workspaceInstanceSave).toHaveBeenCalledTimes(1);
    const payload = bridge.workspaceInstanceSave.mock.calls[0][0] as {
      projectId: string;
      activeModule: string;
      layoutJson: string;
    };
    expect(payload.projectId).toBe("A");
    expect(payload.activeModule).toBe("settings");
    expect(payload.layoutJson).not.toBe("{}");
    const saved = JSON.parse(payload.layoutJson) as {
      moduleOrder: string[];
      hiddenModules: string[];
      activeModule: string;
    };
    expect(saved.moduleOrder).toEqual(["items", "overview", "settings"]);
    expect(saved.hiddenModules).toEqual(["links"]);
    expect(saved.activeModule).toBe("settings");
  });

  it("布局损坏时安全回退并标记 repaired", async () => {
    bridge.workspaceInstanceGet.mockResolvedValueOnce({ instance: instanceRow("A", "{broken") } as never);
    const { result } = renderHook(() => useWorkspaceProjectContext("A", DEV));
    await act(async () => {
      resolveBucket("A", [], []);
      await flush();
    });
    expect(result.current.layoutRepaired).toBe(true);
    expect(result.current.layout.activeModule).toBe("overview");
    expect(result.current.layout.moduleOrder).toEqual(DEV.modules.map((m) => m.id));
  });
});

describe("useWorkspaceDevContext：Git 用开发项目根目录（P1-02 7.3）", () => {
  const dev = {
    id: "dev-1",
    name: "task_dock",
    rootPath: "D:/Develop/task_dock",
    note: "",
    createdAt: "",
    updatedAt: "",
    exists: true,
  };

  it("探测的是 dev_projects 的 rootPath，而不是工作空间工作目录", async () => {
    bridge.devProjectList.mockResolvedValue({ projects: [dev] });
    bridge.devProjectProbe.mockResolvedValue({
      status: "ok",
      branch: "main",
      detached: false,
      isWorktree: false,
      mainRepoPath: null,
      headSha: "abc",
      dirtyCount: 3,
      probedAt: "2026-11-13T00:00:00Z",
    });
    const { result } = renderHook(() => useWorkspaceDevContext("dev-1"));
    await act(async () => {
      await flush(5);
    });
    expect(bridge.devProjectProbe).toHaveBeenCalledWith("D:/Develop/task_dock");
    expect(result.current.status).toBe("ready");
    expect(result.current.probe?.dirtyCount).toBe(3);
  });

  it("登记被删除时给出明确原因且不探测", async () => {
    bridge.devProjectList.mockResolvedValue({ projects: [] });
    const { result } = renderHook(() => useWorkspaceDevContext("dev-missing"));
    await act(async () => {
      await flush(5);
    });
    expect(result.current.status).toBe("missing");
    expect(result.current.reason).toContain("已不存在");
    expect(bridge.devProjectProbe).not.toHaveBeenCalled();
  });

  it("根目录失效时跳过探测并保留登记", async () => {
    bridge.devProjectList.mockResolvedValue({ projects: [{ ...dev, exists: false }] });
    const { result } = renderHook(() => useWorkspaceDevContext("dev-1"));
    await act(async () => {
      await flush(5);
    });
    expect(result.current.status).toBe("missing");
    expect(result.current.devProject?.exists).toBe(false);
    expect(result.current.reason).toContain("根目录不存在");
    expect(bridge.devProjectProbe).not.toHaveBeenCalled();
  });

  it("未关联开发项目时保持 idle", async () => {
    const { result } = renderHook(() => useWorkspaceDevContext(null));
    await act(async () => {
      await flush(2);
    });
    expect(result.current.status).toBe("idle");
    expect(bridge.devProjectList).not.toHaveBeenCalled();
  });
});

describe("useWorkspaceTaskPicker：待办 + 已完成、有界按需查询（P1-02 7.2）", () => {
  it("默认 all + 40 条，已关联项被剔除", async () => {
    bridge.listTasks.mockResolvedValue([
      { id: "t1", title: "待办 A", status: "pending" },
      { id: "t2", title: "已完成 B", status: "completed" },
    ]);
    const { result } = renderHook(() => useWorkspaceTaskPicker(true, ["t2"]));
    await act(async () => {
      await flush(4);
    });
    expect(bridge.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ status: "all", limit: TASK_PICKER_PAGE_SIZE, sort: "created" }),
    );
    expect(result.current.tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("可切换到已完成，并支持按需扩大窗口（上限 200）", async () => {
    bridge.listTasks.mockResolvedValue([]);
    const { result } = renderHook(() => useWorkspaceTaskPicker(true, []));
    await act(async () => {
      await flush(4);
    });
    act(() => result.current.setStatus("completed"));
    await act(async () => {
      await flush(4);
    });
    expect(bridge.listTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "completed" }),
    );

    for (let i = 0; i < 10; i += 1) {
      act(() => result.current.loadMore());
    }
    await act(async () => {
      await flush(4);
    });
    const limits = bridge.listTasks.mock.calls.map((c) => (c[0] as { limit: number }).limit);
    expect(Math.max(...limits)).toBe(TASK_PICKER_MAX_LIMIT);
    expect(result.current.limit).toBe(TASK_PICKER_MAX_LIMIT);
    expect(result.current.canLoadMore).toBe(false);
  });

  it("未启用（不在任务关联页）时不发请求", async () => {
    const { result } = renderHook(() => useWorkspaceTaskPicker(false, []));
    await act(async () => {
      await flush(3);
    });
    expect(bridge.listTasks).not.toHaveBeenCalled();
    expect(result.current.tasks).toEqual([]);
  });

  it("本页大部分已关联但服务端仍返回满页：必须还能加载更多（P1-B 根因）", async () => {
    const raw = Array.from({ length: TASK_PICKER_PAGE_SIZE }, (_, i) => ({
      id: `t${i}`,
      title: `任务 ${i}`,
      status: "pending",
    }));
    bridge.listTasks.mockResolvedValue(raw);
    // 40 条里 32 条已关联，只有 8 条可显示；旧实现按 8 >= 40 判断 → 错误隐藏「加载更多」。
    const linked = raw.slice(0, 32).map((t) => t.id);
    const { result } = renderHook(() => useWorkspaceTaskPicker(true, linked));
    await act(async () => {
      await flush(4);
    });
    expect(result.current.tasks).toHaveLength(8);
    expect(result.current.canLoadMore).toBe(true);

    act(() => result.current.loadMore());
    await act(async () => {
      await flush(4);
    });
    expect(bridge.listTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: TASK_PICKER_PAGE_SIZE * 2 }),
    );
  });

  it("服务端不足一页：不显示加载更多", async () => {
    bridge.listTasks.mockResolvedValue([{ id: "t1", title: "唯一", status: "pending" }]);
    const { result } = renderHook(() => useWorkspaceTaskPicker(true, []));
    await act(async () => {
      await flush(4);
    });
    expect(result.current.canLoadMore).toBe(false);
    expect(result.current.atWindowLimit).toBe(false);
  });

  it("达到 200 条窗口上限：明确提示只能靠搜索缩小范围", async () => {
    const raw = Array.from({ length: TASK_PICKER_MAX_LIMIT }, (_, i) => ({
      id: `t${i}`,
      title: `任务 ${i}`,
      status: "pending",
    }));
    bridge.listTasks.mockResolvedValue(raw);
    const { result } = renderHook(() => useWorkspaceTaskPicker(true, []));
    await act(async () => {
      await flush(4);
    });
    // 一次性扩到上限（模拟用户连续点加载更多）
    for (let i = 0; i < 4; i += 1) {
      act(() => result.current.loadMore());
    }
    await act(async () => {
      await flush(4);
    });
    expect(result.current.limit).toBe(TASK_PICKER_MAX_LIMIT);
    expect(result.current.canLoadMore).toBe(false);
    expect(result.current.atWindowLimit).toBe(true);
  });

  it("切换状态时重置窗口并按新状态查询", async () => {
    bridge.listTasks.mockResolvedValue([]);
    const { result } = renderHook(() => useWorkspaceTaskPicker(true, []));
    await act(async () => {
      await flush(3);
    });
    for (let i = 0; i < 2; i += 1) act(() => result.current.loadMore());
    await act(async () => {
      await flush(3);
    });
    expect(result.current.limit).toBeGreaterThan(TASK_PICKER_PAGE_SIZE);

    act(() => result.current.setStatus("completed"));
    await act(async () => {
      await flush(4);
    });
    expect(result.current.limit).toBe(TASK_PICKER_PAGE_SIZE);
    expect(bridge.listTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "completed", limit: TASK_PICKER_PAGE_SIZE }),
    );
  });
});
