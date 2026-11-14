//! P1-A 项目切换首渲染隔离测试（2026-11-13）。
//!
//! 父组件把 selectedId 从 A 切到 B 时，hook 的 state 仍可能是 A。本测试用
//! **真实 React 父组件切换**记录每一次渲染，断言：
//! 1. 危险帧确实存在（hook 还拿着 A），证明门控不是多余；
//! 2. 任何一帧都不会把 A 的事项显示在 B 标题下；
//! 3. 切换期间状态是 loading（不是「B 已加载但为空」）；
//! 4. 即便 UI 漏渲染了旧按钮，写操作也会按点击时的项目归属拒绝（stale）。

// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
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
  useWorkspaceProjectContext,
  type WorkspaceProjectContext,
} from "./useWorkspaceProjectContext";
import { scopeWorkspaceContext } from "./workspaceContextScope";
import { WORKSPACE_PROFILES } from "./workspaceProfiles";

const DEV = WORKSPACE_PROFILES.development;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (r?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Bucket {
  inst: Deferred<{ instance: unknown }>;
  items: Deferred<{ items: unknown[] }>;
  links: Deferred<{ links: unknown[] }>;
}

const buckets = new Map<string, Bucket>();

function bucket(pid: string): Bucket {
  let b = buckets.get(pid);
  if (!b) {
    b = { inst: deferred(), items: deferred(), links: deferred() };
    buckets.set(pid, b);
  }
  return b;
}

const instanceRow = (pid: string) => ({
  projectId: pid,
  activeModule: "overview",
  layoutJson: "{}",
  lastOpenedAt: null,
});

const itemRow = (pid: string, title: string) => ({
  id: `${pid}-${title}`,
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

function resolveProject(pid: string, titles: string[]) {
  const b = bucket(pid);
  b.inst.resolve({ instance: instanceRow(pid) });
  b.items.resolve({ items: titles.map((t) => itemRow(pid, t)) });
  b.links.resolve({ links: [] });
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

interface RenderRecord {
  pid: string;
  ctxPid: string | null;
  status: string;
  items: string;
}

let renders: RenderRecord[] = [];
let lastScoped: WorkspaceProjectContext | null = null;

function Harness({ pid }: { pid: string }) {
  const ctx = useWorkspaceProjectContext(pid, DEV);
  const scoped = scopeWorkspaceContext(ctx, pid, DEV);
  lastScoped = scoped;
  renders.push({
    pid,
    ctxPid: ctx.projectId,
    status: scoped.status,
    items: scoped.items.map((i) => i.title).join("|"),
  });
  return (
    <div>
      <h1>{pid}</h1>
      <span data-testid="items">{scoped.items.map((i) => i.title).join("|")}</span>
      <span data-testid="status">{scoped.status}</span>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  buckets.clear();
  renders = [];
  lastScoped = null;
  bridge.workspaceInstanceGet.mockImplementation((pid: string) => bucket(pid).inst.promise);
  bridge.workspaceItemList.mockImplementation((pid: string) => bucket(pid).items.promise);
  bridge.workspaceTaskLinkList.mockImplementation((pid: string) => bucket(pid).links.promise);
});

describe("项目切换首渲染隔离", () => {
  it("B 的标题下任何一帧都不会出现 A 的事项", async () => {
    const { rerender } = render(<Harness pid="A" />);
    await act(async () => {
      resolveProject("A", ["A-事项"]);
      await flush();
    });
    expect(renders.some((r) => r.pid === "A" && r.items === "A-事项")).toBe(true);

    renders = [];
    // B 的请求还挂着：这一帧 hook 仍持有 A。
    rerender(<Harness pid="B" />);
    expect(renders.some((r) => r.pid === "B" && r.ctxPid === "A")).toBe(true);
    // 门控后：B 的每一帧都没有 A 的数据，状态是加载中。
    expect(renders.every((r) => r.pid !== "B" || r.items === "")).toBe(true);
    expect(renders.every((r) => r.pid !== "B" || r.status === "loading")).toBe(true);

    await act(async () => {
      resolveProject("B", ["B-事项"]);
      await flush();
    });
    expect(renders.some((r) => r.pid === "B" && r.items === "B-事项")).toBe(true);
  });

  it("切换帧里对旧项目事项的写操作被拒绝，不会写到新项目", async () => {
    const { rerender } = render(<Harness pid="A" />);
    await act(async () => {
      resolveProject("A", ["A-事项"]);
      await flush();
    });
    rerender(<Harness pid="B" />);
    await act(async () => {
      await flush();
    });

    const scoped = lastScoped;
    expect(scoped).not.toBeNull();
    const staleItem = itemRow("A", "A-事项");
    const outcome = await scoped!.cycleItemStatus(staleItem as never);
    expect(outcome).toBe("stale");
    expect(bridge.workspaceItemSave).not.toHaveBeenCalled();
  });

  it("A→B→A 快速切换：只显示最后一次选择的数据", async () => {
    const { rerender } = render(<Harness pid="A" />);
    await act(async () => {
      resolveProject("A", ["A-事项"]);
      await flush();
    });

    renders = [];
    rerender(<Harness pid="B" />);
    rerender(<Harness pid="A" />);
    await act(async () => {
      // B 的响应迟到：不得覆盖已经切回的 A
      resolveProject("B", ["B-事项"]);
      await flush();
    });

    const visible = renders.at(-1);
    expect(visible?.pid).toBe("A");
    expect(visible?.items).toBe("A-事项");
    expect(renders.every((r) => r.pid !== "A" || !r.items.includes("B-事项"))).toBe(true);
  });
});
