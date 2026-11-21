/**
 * @vitest-environment jsdom
 */
//! 回收站视图交互回归：缓存打开与首次同步、后台同步事件、磁盘筛选与分页、
//! 虚拟滚动与并发去重、跨页选择、缓存淘汰后选择不丢失、恢复/永久删除、异常
//! 条目的索引移除语义、部分失败与对账失败、取消未生效、重开刷新、清空范围。
//! 只 mock IPC，不触碰真实回收站。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FileJobSnapshot,
  RecycleItem,
  RecyclePage,
  RecycleQuery,
  RecycleScanProgress,
  RecycleStats,
  RecycleSyncStatus,
  RecycleSyncSummary,
} from "../../lib/bridge";

const bridge = vi.hoisted(() => ({
  recycleEmpty: vi.fn(),
  recycleList: vi.fn(),
  recyclePurge: vi.fn(),
  recycleRestore: vi.fn(),
  recycleStats: vi.fn(),
  recycleSync: vi.fn(),
  recycleSyncCancel: vi.fn(),
  recycleSyncStatus: vi.fn(),
  fsJobCancel: vi.fn(),
  fsJobStatus: vi.fn(),
  onRecycleJobProgress: vi.fn(),
  onRecycleSyncDone: vi.fn(),
  onRecycleSyncProgress: vi.fn(),
}));

vi.mock("../../lib/bridge", async () => {
  const actual = await vi.importActual<typeof import("../../lib/bridge")>("../../lib/bridge");
  return { ...bridge, isFileJobTerminal: actual.isFileJobTerminal };
});

import RecycleWorkspaceView from "./RecycleWorkspaceView";
import { useUiStore } from "../../store/useUiStore";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

let jobListener: ((snapshot: FileJobSnapshot) => void) | null = null;
let syncProgressListener: ((progress: RecycleScanProgress) => void) | null = null;
let syncDoneListener: ((summary: RecycleSyncSummary) => void) | null = null;

const stats = (over: Partial<RecycleStats> = {}): RecycleStats => ({
  items: 5,
  files: 4,
  folders: 1,
  knownBytes: 4096,
  unknownSize: 0,
  volumes: [
    {
      volume: "C:",
      items: 5,
      files: 4,
      folders: 1,
      knownBytes: 4096,
      unknownSize: 0,
      state: "ok",
      lastSyncMs: 1000,
      systemItems: 5,
      systemBytes: 4096,
      systemCheckedMs: 1000,
      errorCode: null,
    },
    {
      volume: "D:",
      items: 0,
      files: 0,
      folders: 0,
      knownBytes: 0,
      unknownSize: 0,
      state: "ok",
      lastSyncMs: 1000,
      systemItems: 0,
      systemBytes: 0,
      systemCheckedMs: 1000,
      errorCode: null,
    },
  ],
  lastSyncMs: 1000,
  state: "ready",
  source: "index",
  indexedAtMs: 1000,
  syncing: 0,
  ...over,
});

const syncStatus: RecycleSyncStatus = {
  running: false,
  startedMs: 0,
  finishedMs: 0,
  volumesDone: 0,
  volumesTotal: 0,
  cancelRequested: false,
  lastError: null,
};

const item = (id: string, over: Partial<RecycleItem> = {}): RecycleItem => ({
  id,
  volume: "C:",
  name: `${id}.txt`,
  originalPath: `C:\\tmp\\${id}.txt`,
  isDir: false,
  size: 10,
  deletedMs: 1000,
  state: "present",
  anomaly: null,
  ...over,
});

const pageItems = (prefix: string, count = 4): RecycleItem[] =>
  Array.from({ length: count }, (_, index) => item(`${prefix}${index}`));

const job = (over: Partial<FileJobSnapshot> = {}): FileJobSnapshot => ({
  id: "job-1",
  kind: "empty",
  status: "pending",
  total: 2,
  done: 0,
  ok: 0,
  failed: 0,
  partial: 0,
  skipped: 0,
  phase: "queued",
  cancelable: true,
  cancelRequested: false,
  startedMs: 0,
  finishedMs: 0,
  failures: [],
  message: null,
  ...over,
});

/** 虚拟列表滚动：直接定义 scrollTop，避免 jsdom 未实现布局导致读回 0。 */
function scrollTo(top: number) {
  const scroller = screen.getByRole("listbox", { name: "回收站项目" });
  Object.defineProperty(scroller, "scrollTop", { value: top, configurable: true, writable: true });
  fireEvent.scroll(scroller);
}

const listQueries = (): RecycleQuery[] =>
  bridge.recycleList.mock.calls.map((call) => call[0] as RecycleQuery);

beforeEach(() => {
  jobListener = null;
  syncProgressListener = null;
  syncDoneListener = null;
  useUiStore.setState({ toast: null, toasts: [] });
  bridge.recycleStats.mockResolvedValue(stats());
  bridge.recycleSyncStatus.mockResolvedValue(syncStatus);
  bridge.recycleSync.mockResolvedValue(syncStatus);
  bridge.recycleList.mockResolvedValue({ items: [item("a")], total: 1, offset: 0, limit: 400, stats: null, queryMs: 3 });
  bridge.recycleEmpty.mockResolvedValue(job());
  bridge.recycleRestore.mockResolvedValue(job({ kind: "restore" }));
  bridge.recyclePurge.mockResolvedValue(job({ kind: "purge" }));
  bridge.fsJobCancel.mockResolvedValue(true);
  bridge.fsJobStatus.mockResolvedValue(job());
  bridge.onRecycleSyncProgress.mockImplementation(async (cb: (progress: RecycleScanProgress) => void) => {
    syncProgressListener = cb;
    return () => {};
  });
  bridge.onRecycleSyncDone.mockImplementation(async (cb: (summary: RecycleSyncSummary) => void) => {
    syncDoneListener = cb;
    return () => {};
  });
  bridge.onRecycleJobProgress.mockImplementation(async (cb: (s: FileJobSnapshot) => void) => {
    jobListener = cb;
    return () => {};
  });
});

describe("RecycleWorkspaceView 打开与同步", () => {
  it("已有索引：先读缓存统计与列表，再以 force=false 触发节流同步", async () => {
    render(<RecycleWorkspaceView />);
    await waitFor(() => expect(bridge.recycleSync).toHaveBeenCalledTimes(1));

    expect(bridge.recycleSync).toHaveBeenCalledWith(false);
    expect(bridge.recycleStats).toHaveBeenCalled();
    expect(bridge.recycleList).toHaveBeenCalled();
    expect(bridge.recycleStats.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.recycleSync.mock.invocationCallOrder[0],
    );
    expect(bridge.recycleList.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.recycleSync.mock.invocationCallOrder[0],
    );
  });

  it("首次没有索引（indexedAtMs=0）时以 force=true 建立索引，并提示先同步", async () => {
    bridge.recycleStats.mockResolvedValue(
      stats({ indexedAtMs: 0, items: 0, files: 0, folders: 0, knownBytes: 0, volumes: [], state: "empty" }),
    );
    bridge.recycleList.mockResolvedValue({ items: [], total: 0, offset: 0, limit: 400, stats: null, queryMs: 1 });

    render(<RecycleWorkspaceView />);
    await waitFor(() => expect(bridge.recycleSync).toHaveBeenCalledWith(true));
    expect(
      await screen.findByText("索引尚未建立；点「立即同步」读取回收站（不扫描文件大小）。"),
    ).toBeTruthy();
  });

  it("后台同步：进度事件更新进度条，完成事件刷新统计与首页并提示完成", async () => {
    bridge.recycleSync.mockResolvedValue({
      ...syncStatus,
      running: true,
      volumesTotal: 2,
      volumesDone: 0,
    });
    render(<RecycleWorkspaceView />);
    await waitFor(() => expect(syncProgressListener).not.toBeNull());
    expect(await screen.findByText("同步中 0/2")).toBeTruthy();

    act(() =>
      syncProgressListener?.({
        volume: "C:",
        phase: "reading",
        done: 3,
        total: 10,
        added: 1,
        updated: 0,
        removed: 0,
      }),
    );
    expect(screen.getByText("同步 C:：3/10")).toBeTruthy();

    bridge.recycleStats.mockClear();
    bridge.recycleList.mockClear();
    act(() =>
      syncDoneListener?.({
        startedMs: 1,
        finishedMs: 2,
        durationMs: 1,
        cancelled: false,
        volumes: [
          {
            volume: "C:",
            state: "ok",
            items: 3,
            added: 1,
            updated: 0,
            removed: 0,
            durationMs: 1,
            errorCode: null,
          },
        ],
        error: null,
      }),
    );

    await waitFor(() => expect(bridge.recycleStats).toHaveBeenCalled());
    await waitFor(() => expect(bridge.recycleList).toHaveBeenCalled());
    expect(screen.queryByText("同步 C:：3/10")).toBeNull();
    expect(screen.getByText(/\+1 ~0 -0/)).toBeTruthy();
    expect(useUiStore.getState().toasts.some((toast) => toast.message === "同步完成（1 个卷）")).toBe(true);
  });
});

describe("RecycleWorkspaceView 筛选与分页", () => {
  it("切换磁盘后列表请求带 volume，统计只在首页拉取", async () => {
    render(<RecycleWorkspaceView />);
    await screen.findByRole("button", { name: "清空回收站" });
    await waitFor(() => expect(bridge.recycleList).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("combobox", { name: "磁盘" }));
    const volumeList = await screen.findByRole("listbox", { name: "磁盘" });
    fireEvent.click(within(volumeList).getByRole("option", { name: /D: \(0\)/ }));

    await waitFor(() =>
      expect(listQueries().some((query) => query.volume === "D:" && query.offset === 0)).toBe(true),
    );
    const queries = listQueries();
    // 首次进入 + 切换磁盘各一次全量统计；翻页/预取一律不带统计。
    expect(queries.filter((query) => query.includeStats).length).toBe(2);
    expect(queries.filter((query) => query.offset !== 0).every((query) => query.includeStats === false)).toBe(
      true,
    );
  });

  it("滚动到未缓存页按 400 分页补齐，同一 offset 不重复并发", async () => {
    const total = 2000;
    let release400: (() => void) | null = null;
    bridge.recycleList.mockImplementation((query: RecycleQuery) => {
      const offset = query.offset ?? 0;
      if (offset === 400) {
        return new Promise<RecyclePage>((resolve) => {
          release400 = () =>
            resolve({ items: pageItems("p1"), total, offset, limit: 400, stats: null, queryMs: 2 });
        });
      }
      return Promise.resolve({
        items: offset === 0 ? pageItems("p0") : pageItems(`p${offset}`),
        total,
        offset,
        limit: 400,
        stats: null,
        queryMs: 2,
      });
    });

    render(<RecycleWorkspaceView />);
    await screen.findByText("p00.txt");

    const callsAt400 = () => listQueries().filter((query) => query.offset === 400);
    scrollTo(12200);
    await waitFor(() => expect(callsAt400()).toHaveLength(1));
    expect(callsAt400()[0]).toMatchObject({ offset: 400, limit: 400, includeStats: false });

    // 回顶再滚回同一页：该页请求仍在途，不能重复发起。
    scrollTo(0);
    scrollTo(12200);
    expect(callsAt400()).toHaveLength(1);

    await act(async () => {
      release400?.();
    });
    expect(await screen.findByText("p10.txt")).toBeTruthy();
    expect(callsAt400()).toHaveLength(1);
  });
});

describe("RecycleWorkspaceView 选择", () => {
  it("跨页勾选保留已选，Shift 区间选中当前可见范围，Ctrl+A 只选当前页", async () => {
    const total = 800;
    bridge.recycleList.mockImplementation((query: RecycleQuery) => {
      const offset = query.offset ?? 0;
      return Promise.resolve({
        items: pageItems(offset === 0 ? "p0" : "p1"),
        total,
        offset,
        limit: 400,
        stats: null,
        queryMs: 2,
      });
    });

    const { container } = render(<RecycleWorkspaceView />);
    fireEvent.click(await screen.findByRole("option", { name: /p00\.txt/ }));
    expect(screen.getByText("已选择 1 项")).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: /p02\.txt/ }), { shiftKey: true });
    expect(screen.getByText("已选择 3 项")).toBeTruthy();

    scrollTo(12200);
    fireEvent.click(await screen.findByRole("option", { name: /p10\.txt/ }), { ctrlKey: true });
    expect(screen.getByText("已选择 4 项")).toBeTruthy();

    fireEvent.keyDown(container.querySelector(".rc-view") as HTMLElement, { key: "a", ctrlKey: true });
    // 当前页 4 项全部加入（跨页已选的 3 项保留），而不是把另外 4 项也一并选中。
    expect(screen.getByText("已选择 7 项")).toBeTruthy();
  });

  it("缓存页被淘汰后选中项不丢失，批量永久删除仍覆盖全部所选", async () => {
    const total = 3200;
    bridge.recycleList.mockImplementation((query: RecycleQuery) => {
      const offset = query.offset ?? 0;
      return Promise.resolve({
        items: pageItems(`p${offset / 400}`),
        total,
        offset,
        limit: 400,
        stats: null,
        queryMs: 2,
      });
    });

    render(<RecycleWorkspaceView />);
    fireEvent.click(await screen.findByRole("option", { name: /p00\.txt/ }));
    scrollTo(12200);
    fireEvent.click(await screen.findByRole("option", { name: /p10\.txt/ }), { ctrlKey: true });
    expect(screen.getByText("已选择 2 项")).toBeTruthy();
    expect(screen.queryByText("部分选中项尚未加载，操作只作用于已加载项")).toBeNull();

    // 逐页滚动把最早的第 1 页挤出 6 页缓存窗口。
    scrollTo(24200);
    await screen.findByRole("option", { name: /p20\.txt/ });
    scrollTo(36200);
    await screen.findByRole("option", { name: /p30\.txt/ });
    scrollTo(48200);
    await screen.findByRole("option", { name: /p40\.txt/ });
    scrollTo(60200);
    await screen.findByRole("option", { name: /p50\.txt/ });

    // 选择数量由 selectedIds 决定，不随缓存淘汰变化，也不再出现部分选择提示。
    expect(screen.getByText("已选择 2 项")).toBeTruthy();
    expect(screen.queryByText(/部分选中项尚未加载/)).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "永久删除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "永久删除 2 项？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(bridge.recyclePurge).toHaveBeenCalledTimes(1));
    const purged = bridge.recyclePurge.mock.calls[0][0] as string[];
    expect(purged).toHaveLength(2);
    expect(purged).toEqual(expect.arrayContaining(["p00", "p10"]));
  });
});

describe("RecycleWorkspaceView 批量操作", () => {
  it("恢复确认选择 rename 后，recycleRestore 收到 ids、rename 与 operationId", async () => {
    render(<RecycleWorkspaceView />);
    fireEvent.click(await screen.findByRole("option", { name: /a\.txt/ }));

    fireEvent.click(screen.getAllByRole("button", { name: "恢复" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "恢复 1 项" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /保留两者/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "开始恢复" }));

    await waitFor(() =>
      expect(bridge.recycleRestore).toHaveBeenCalledWith(["a"], "rename", expect.any(String)),
    );
  });

  it("永久删除确认后，recyclePurge 收到选中 ids", async () => {
    render(<RecycleWorkspaceView />);
    fireEvent.click(await screen.findByRole("option", { name: /a\.txt/ }));

    fireEvent.click(screen.getAllByRole("button", { name: "永久删除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "永久删除 1 项？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(bridge.recyclePurge).toHaveBeenCalledWith(["a"], expect.any(String)));
  });

  it("跨页选择后批量恢复不漏项，recycleRestore 收到全部所选 ID", async () => {
    const total = 800;
    bridge.recycleList.mockImplementation((query: RecycleQuery) => {
      const offset = query.offset ?? 0;
      return Promise.resolve({
        items: pageItems(offset === 0 ? "p0" : "p1"),
        total,
        offset,
        limit: 400,
        stats: null,
        queryMs: 2,
      });
    });

    render(<RecycleWorkspaceView />);
    fireEvent.click(await screen.findByRole("option", { name: /p00\.txt/ }));
    scrollTo(12200);
    fireEvent.click(await screen.findByRole("option", { name: /p10\.txt/ }), { ctrlKey: true });
    expect(screen.getByText("已选择 2 项")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "恢复" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "恢复 2 项" });
    fireEvent.click(within(dialog).getByRole("button", { name: "开始恢复" }));

    await waitFor(() => expect(bridge.recycleRestore).toHaveBeenCalledTimes(1));
    const restored = bridge.recycleRestore.mock.calls[0][0] as string[];
    expect(restored).toHaveLength(2);
    expect(restored).toEqual(expect.arrayContaining(["p00", "p10"]));
  });
});

describe("RecycleWorkspaceView 异常条目语义", () => {
  it("仅选中 missing_data 项时，永久删除按钮显示「从索引移除」并在确认后仍提交该 ID", async () => {
    bridge.recycleList.mockResolvedValue({
      items: [item("m0", { state: "missing_data", anomaly: "ORPHAN_DATA" })],
      total: 1,
      offset: 0,
      limit: 400,
      stats: null,
      queryMs: 2,
    });

    render(<RecycleWorkspaceView />);
    fireEvent.click(await screen.findByRole("option", { name: /m0\.txt/ }));

    // 工具栏按钮：全部选中项都是异常项，只能是索引移除。
    fireEvent.click(screen.getAllByRole("button", { name: "从索引移除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "永久删除 1 项？" });
    expect(within(dialog).getByText(/只从索引移除/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "从索引移除" }));

    await waitFor(() => expect(bridge.recyclePurge).toHaveBeenCalledWith(["m0"], expect.any(String)));
  });

  it("missing_data 项的详情面板不显示「恢复」按钮，只提示索引移除", async () => {
    bridge.recycleList.mockResolvedValue({
      items: [item("m0", { state: "missing_data" })],
      total: 1,
      offset: 0,
      limit: 400,
      stats: null,
      queryMs: 2,
    });

    render(<RecycleWorkspaceView />);
    fireEvent.click(await screen.findByRole("option", { name: /m0\.txt/ }));

    const detail = await screen.findByLabelText("项目详情");
    expect(within(detail).queryByRole("button", { name: "恢复" })).toBeNull();
    expect(within(detail).getByRole("button", { name: "从索引移除" })).toBeTruthy();
    expect(within(detail).getByText(/只能从索引移除/)).toBeTruthy();
  });
});

describe("RecycleWorkspaceView 清空范围", () => {
  it("默认勾选有内容的磁盘；取消勾选后禁止提交；确认后只清所选卷", async () => {
    render(<RecycleWorkspaceView />);
    const emptyButton = await screen.findByRole("button", { name: "清空回收站" });
    await waitFor(() => expect((emptyButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(emptyButton);

    await screen.findByRole("dialog", { name: /清空.*全部 1 个磁盘.*回收站/ });
    const volume = screen.getByRole("checkbox", { name: "选择磁盘 C:" }) as HTMLInputElement;
    expect(volume.checked).toBe(true);
    // D: 没有内容：不可勾选，也不会进入提交范围。
    const emptyVolume = screen.getByRole("checkbox", { name: "选择磁盘 D:" }) as HTMLInputElement;
    expect(emptyVolume.disabled).toBe(true);

    fireEvent.click(volume);
    expect(screen.getByText("请至少选择一个磁盘。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认清空" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(volume);
    fireEvent.click(screen.getByRole("checkbox", { name: "我已知晓此操作不可恢复" }));
    const confirm = screen.getByRole("button", { name: "确认清空" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(bridge.recycleEmpty).toHaveBeenCalledTimes(1));
    expect(bridge.recycleEmpty.mock.calls[0][0]).toEqual(["C:"]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /清空.*回收站/ })).toBeNull());
  });

  it("索引不完整时提示只处理已勾选磁盘", async () => {
    bridge.recycleStats.mockResolvedValue(stats({ state: "partial" }));
    render(<RecycleWorkspaceView />);
    const emptyButton = await screen.findByRole("button", { name: "清空回收站" });
    await waitFor(() => expect((emptyButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(emptyButton);

    expect(await screen.findByText(/当前索引不完整或存在离线磁盘/)).toBeTruthy();
  });
});

describe("RecycleWorkspaceView 任务状态", () => {
  it("pending 可取消；取消受理后进入 cancelling 不再显示取消按钮", async () => {
    render(<RecycleWorkspaceView />);
    await screen.findByRole("button", { name: "清空回收站" });
    await waitFor(() => expect(jobListener).not.toBeNull());

    act(() => jobListener?.(job()));
    const cancel = await screen.findByRole("button", { name: "取消排队任务" });
    fireEvent.click(cancel);

    await waitFor(() => expect(bridge.fsJobCancel).toHaveBeenCalledWith("job-1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "取消排队任务" })).toBeNull());

    act(() => jobListener?.(job({ status: "cancelling", cancelRequested: true })));
    expect(screen.getByText(/正在取消/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消任务" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消排队任务" })).toBeNull();
  });

  it("取消未生效时提示原因，且状态不进入 cancelling", async () => {
    bridge.fsJobCancel.mockResolvedValue(false);
    bridge.fsJobStatus.mockResolvedValue(job({ status: "running", total: 2, done: 0 }));
    render(<RecycleWorkspaceView />);
    await screen.findByRole("button", { name: "清空回收站" });
    await waitFor(() => expect(jobListener).not.toBeNull());

    act(() => jobListener?.(job({ status: "running", total: 2, done: 0 })));
    fireEvent.click(await screen.findByRole("button", { name: "取消任务" }));

    await waitFor(() =>
      expect(
        useUiStore.getState().toasts.some((toast) => toast.message.includes("取消未生效")),
      ).toBe(true),
    );
    expect(screen.queryByText(/正在取消/)).toBeNull();
    expect(screen.getByText(/已处理 0\/2 · 成功 0 · 失败 0/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消任务" })).toBeTruthy();
  });

  it("清空启动后取消：说明部分项目已永久删除，并显示索引待更新", async () => {
    render(<RecycleWorkspaceView />);
    await screen.findByRole("button", { name: "清空回收站" });
    await waitFor(() => expect(jobListener).not.toBeNull());

    act(() =>
      jobListener?.(
        job({
          status: "cancelled",
          total: 2,
          done: 1,
          ok: 0,
          failed: 0,
          skipped: 1,
          indexPending: 1,
          message: "清空已取消：部分项目已永久删除，正在按真实 $I/$R 重新核对",
        }),
      ),
    );

    // 取消不能被读成「回滚」：必须带出任务级说明与索引待更新提示。
    expect(await screen.findByText(/部分项目已永久删除/)).toBeTruthy();
    expect(screen.getByText("索引待更新 1 卷")).toBeTruthy();
    // 仍是取消态，不能落到「成功 x · 失败 y · 跳过 z」的完成文案。
    expect(screen.queryByText(/^清空任务 · 成功 0 · 失败 0 · 跳过 1$/)).toBeNull();
  });

  it("部分失败显示部分完成结果，不冒充成功也不弹成功提示", async () => {
    render(<RecycleWorkspaceView />);
    await screen.findByRole("button", { name: "清空回收站" });
    await waitFor(() => expect(jobListener).not.toBeNull());

    act(() =>
      jobListener?.(job({ status: "partial", total: 2, done: 2, ok: 1, failed: 1, skipped: 0 })),
    );

    expect(await screen.findByText(/部分完成：成功 1 · 失败 1 · 跳过 0/)).toBeTruthy();
    expect(screen.queryByText("清空任务 · 成功 1 · 失败 1 · 跳过 0")).toBeNull();
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });

  it("数据库对账失败（INDEX_UPDATE_FAILED）可见且不显示为完成", async () => {
    render(<RecycleWorkspaceView />);
    await screen.findByRole("button", { name: "清空回收站" });
    await waitFor(() => expect(jobListener).not.toBeNull());

    act(() =>
      jobListener?.(
        job({
          status: "partial",
          total: 2,
          done: 2,
          ok: 1,
          failed: 1,
          skipped: 0,
          failures: [{ label: "D:", status: "failed", code: "INDEX_UPDATE_FAILED", message: null }],
        }),
      ),
    );

    const failures = await screen.findByText("1 项失败");
    expect(failures.getAttribute("data-tip")).toContain("INDEX_UPDATE_FAILED");
    expect(screen.getByText(/部分完成：成功 1 · 失败 1/)).toBeTruthy();
    expect(screen.queryByText("清空任务 · 成功 1 · 失败 1 · 跳过 0")).toBeNull();
  });

  it("终态停止轮询并刷新首页统计与列表", async () => {
    bridge.recycleList.mockClear();
    render(<RecycleWorkspaceView />);
    await screen.findByRole("button", { name: "清空回收站" });
    await waitFor(() => expect(jobListener).not.toBeNull());
    bridge.recycleList.mockClear();
    bridge.recycleStats.mockClear();

    act(() => jobListener?.(job({ status: "completed", done: 2, ok: 2, finishedMs: Date.now() })));
    await waitFor(() => expect(screen.getByText(/成功 2/)).toBeTruthy());
    await waitFor(() => expect(bridge.recycleList).toHaveBeenCalled());
    await waitFor(() => expect(bridge.recycleStats).toHaveBeenCalled());
    expect(bridge.fsJobStatus).not.toHaveBeenCalled();
  });

  it("普通状态查询错误不冒充任务不存在，任务仍可继续到终态", async () => {
    bridge.fsJobStatus
      .mockRejectedValueOnce(new Error("IPC channel closed"))
      .mockRejectedValueOnce(new Error("IPC channel closed"));
    render(<RecycleWorkspaceView />);
    await screen.findByRole("button", { name: "清空回收站" });
    await waitFor(() => expect(jobListener).not.toBeNull());

    act(() => jobListener?.(job({ status: "running", done: 0 })));
    await waitFor(() => expect(bridge.fsJobStatus).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(screen.queryByText(/任务状态已不可追踪/)).toBeNull();

    act(() => jobListener?.(job({ status: "completed", done: 2, ok: 2, finishedMs: Date.now() })));
    await waitFor(() => expect(screen.getByText(/成功 2/)).toBeTruthy());
  });
});

describe("RecycleWorkspaceView 重开刷新", () => {
  it("重新打开视图时重新读取索引并展示最新数据", async () => {
    const first = render(<RecycleWorkspaceView />);
    expect(await screen.findByText(/5 项/)).toBeTruthy();
    expect(await screen.findByText("a.txt")).toBeTruthy();
    first.unmount();

    bridge.recycleStats.mockResolvedValue(stats({ items: 9, files: 8, folders: 1 }));
    bridge.recycleList.mockResolvedValue({
      items: [item("z")],
      total: 1,
      offset: 0,
      limit: 400,
      stats: null,
      queryMs: 2,
    });

    render(<RecycleWorkspaceView />);
    expect(await screen.findByText(/9 项/)).toBeTruthy();
    expect(await screen.findByText("z.txt")).toBeTruthy();
    expect(bridge.recycleStats).toHaveBeenCalledTimes(2);
  });
});
