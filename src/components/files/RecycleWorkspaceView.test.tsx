/**
 * @vitest-environment jsdom
 */
//! 回收站任务交互：清空范围与勾选一致、空选择禁止提交、pending 可取消且
//! cancelling 后不重复显示取消入口。只 mock IPC，不触碰真实回收站。

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileJobSnapshot, RecycleItem, RecycleStats, RecycleSyncStatus } from "../../lib/bridge";

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

let jobListener: ((snapshot: FileJobSnapshot) => void) | null = null;

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

const item = (id: string): RecycleItem => ({
  id,
  volume: "C:",
  name: `${id}.txt`,
  originalPath: `C:\\tmp\\${id}.txt`,
  isDir: false,
  size: 10,
  deletedMs: 1000,
  state: "present",
  anomaly: null,
});

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

beforeEach(() => {
  jobListener = null;
  bridge.recycleStats.mockResolvedValue(stats());
  bridge.recycleSyncStatus.mockResolvedValue(syncStatus);
  bridge.recycleSync.mockResolvedValue(syncStatus);
  bridge.recycleList.mockResolvedValue({ items: [item("a")], total: 1, offset: 0, limit: 400, stats: null, queryMs: 3 });
  bridge.recycleEmpty.mockResolvedValue(job());
  bridge.fsJobCancel.mockResolvedValue(true);
  bridge.fsJobStatus.mockResolvedValue(job());
  bridge.onRecycleSyncProgress.mockImplementation(async () => () => {});
  bridge.onRecycleSyncDone.mockImplementation(async () => () => {});
  bridge.onRecycleJobProgress.mockImplementation(async (cb: (s: FileJobSnapshot) => void) => {
    jobListener = cb;
    return () => {};
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

describe("RecycleWorkspaceView 任务取消", () => {
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
