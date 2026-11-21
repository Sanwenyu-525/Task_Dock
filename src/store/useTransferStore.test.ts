// @vitest-environment jsdom
//! 工作篮 store：加入报告、重试参数沿用、撤销移除、批次事件同步。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = {
  addItems: vi.fn(),
  removeItems: vi.fn(),
  getItem: vi.fn(),
  listItems: vi.fn(),
  getCounts: vi.fn(),
  executeTransfer: vi.fn(),
  getBatch: vi.fn(),
  retryBatch: vi.fn(),
  undoBatch: vi.fn(),
  reorderItems: vi.fn(),
  pinItem: vi.fn(),
  clearTemporary: vi.fn(),
};

vi.mock("../lib/crossTab/transferClient", () => ({
  DEFAULT_OPTIONS: {
    conflict: "rename",
    textFormat: "txt",
    textMode: "separate",
    fileOperation: "copy",
    urlMode: "url",
  },
  addItems: (...args: unknown[]) => api.addItems(...args),
  removeItems: (...args: unknown[]) => api.removeItems(...args),
  getItem: (...args: unknown[]) => api.getItem(...args),
  listItems: (...args: unknown[]) => api.listItems(...args),
  getCounts: (...args: unknown[]) => api.getCounts(...args),
  executeTransfer: (...args: unknown[]) => api.executeTransfer(...args),
  getBatch: (...args: unknown[]) => api.getBatch(...args),
  retryBatch: (...args: unknown[]) => api.retryBatch(...args),
  undoBatch: (...args: unknown[]) => api.undoBatch(...args),
  reorderItems: (...args: unknown[]) => api.reorderItems(...args),
  pinItem: (...args: unknown[]) => api.pinItem(...args),
  clearTemporary: (...args: unknown[]) => api.clearTemporary(...args),
}));

import { resetTransferPanelForTests, useTransferStore } from "./useTransferStore";
import type { TransferBatch, TransferItem } from "../lib/crossTab/types";

function item(overrides: Partial<TransferItem> = {}): TransferItem {
  return {
    id: "a",
    itemType: "text",
    sourceModule: "clipboard",
    sourceId: "s",
    title: "标题",
    description: "",
    content: "正文",
    payload: {},
    sortOrder: 0,
    pinned: false,
    status: "ready",
    errorCode: "",
    errorMessage: "",
    lastTarget: "",
    createdAt: "",
    updatedAt: "",
    sentAt: null,
    expiresAt: null,
    available: true,
    unavailableReason: "",
    ...overrides,
  };
}

function batch(overrides: Partial<TransferBatch> = {}): TransferBatch {
  return {
    id: "b1",
    targetModule: "files",
    targetRef: "D:\\out",
    operation: "copy",
    status: "running",
    total: 1,
    ok: 0,
    failed: 0,
    skipped: 0,
    jobIds: [],
    entries: [],
    undoState: "available",
    undoReason: "",
    message: "",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

beforeEach(() => {
  resetTransferPanelForTests();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listItems.mockResolvedValue({ items: [], total: 0 });
  api.getCounts.mockResolvedValue({ total: 0, ready: 0, failed: 0, pinned: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTransferStore", () => {
  it("add() 保留后端 rejected，不丢弃失败原因", async () => {
    api.addItems.mockResolvedValue({
      items: [item()],
      duplicates: 1,
      rejected: [{ title: "x.txt", code: "TRANSFER_SOURCE_MISSING", message: "文件不存在" }],
    });
    const result = await useTransferStore.getState().add([
      { itemType: "text", sourceModule: "clipboard", content: "x" },
    ]);
    expect(result.added).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("TRANSFER_SOURCE_MISSING");
  });

  it("重试沿用原始目标与冲突策略（不使用默认值）", async () => {
    vi.useFakeTimers();
    const original = {
      conflict: "skip" as const,
      textFormat: "md" as const,
      textMode: "merge" as const,
      fileOperation: "move" as const,
      urlMode: "markdown" as const,
    };
    useTransferStore.setState({
      activeBatch: batch(),
      pending: { ids: ["a"], target: { module: "files", ref: "D:\\out" }, options: original },
    });
    api.retryBatch.mockResolvedValue(batch({ id: "b2", status: "running" }));
    api.getBatch.mockResolvedValue(batch({ id: "b2", status: "running" }));

    await useTransferStore.getState().retry();
    expect(api.retryBatch).toHaveBeenCalledWith("b1", original);
    // 新批次进入监控（send 与 retry 共用同一套监控方法）。
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getBatch).toHaveBeenCalledWith("b2");
  });

  it("撤销移除按原 id 与正文恢复条目", async () => {
    useTransferStore.setState({
      lastRemoved: { items: [item({ id: "keep-me", content: "完整正文" })], at: Date.now() },
    });
    api.addItems.mockResolvedValue({ items: [item({ id: "keep-me" })], duplicates: 0, rejected: [] });
    const restored = await useTransferStore.getState().undoRemove();
    expect(restored).toBe(1);
    const input = api.addItems.mock.calls[0][0][0] as { id: string; content: string };
    expect(input.id).toBe("keep-me");
    expect(input.content).toBe("完整正文");
    expect(useTransferStore.getState().lastRemoved).toBeNull();
  });

  it("remove() 在删除前抓取完整快照（含正文）", async () => {
    api.getItem.mockResolvedValue(item({ id: "a", content: "原始正文" }));
    api.removeItems.mockResolvedValue({ removed: 1 });
    await useTransferStore.getState().remove(["a"]);
    const snapshot = useTransferStore.getState().lastRemoved;
    expect(snapshot?.items[0].content).toBe("原始正文");
  });

  it("批次事件更新 activeBatch，而不是只刷新列表", () => {
    useTransferStore.setState({ activeBatch: batch({ ok: 0 }) });
    useTransferStore.getState().handleBatchEvent({ ...batch(), ok: 1, total: 1 });
    expect(useTransferStore.getState().activeBatch?.ok).toBe(1);
  });

  it("ensureLoaded 只请求一次（切换面板形态不重复请求）", async () => {
    await useTransferStore.getState().ensureLoaded();
    await useTransferStore.getState().ensureLoaded();
    expect(api.listItems).toHaveBeenCalledTimes(1);
  });

  it("invertSelection 只反转可发送条目", () => {
    useTransferStore.setState({
      items: [item({ id: "a" }), item({ id: "b", status: "sent" })],
      selection: [],
    });
    useTransferStore.getState().invertSelection();
    expect(useTransferStore.getState().selection).toEqual(["a"]);
    useTransferStore.getState().invertSelection();
    expect(useTransferStore.getState().selection).toEqual([]);
  });
});

describe("useTransferStore 批次监控退避", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.listItems.mockResolvedValue({ items: [], total: 0 });
    api.getCounts.mockResolvedValue({ total: 0, ready: 0, failed: 0, pinned: 0 });
  });

  async function startRunningBatch() {
    api.executeTransfer.mockResolvedValue(batch({ id: "b9", status: "running" }));
    await useTransferStore.getState().send(["a"], { module: "files", ref: "D://out" });
    await vi.advanceTimersByTimeAsync(0);
  }

  it("单次查询失败后按退避继续轮询，而不是永久停止", async () => {
    api.getBatch.mockRejectedValueOnce(new Error("backend busy"));
    await startRunningBatch();

    let state = useTransferStore.getState();
    expect(state.monitorState).toBe("retrying");
    expect(state.monitorAttempts).toBe(1);
    // 失败不得清空批次或把它当成完成。
    expect(state.activeBatch?.id).toBe("b9");

    api.getBatch.mockResolvedValue(batch({ id: "b9", status: "running" }));
    await vi.advanceTimersByTimeAsync(1300);
    state = useTransferStore.getState();
    expect(state.monitorState).toBe("polling");
    expect(state.monitorError).toBeNull();
    expect(state.monitorAttempts).toBe(0);
    expect(api.getBatch).toHaveBeenCalledTimes(2);
  });

  it("连续失败到上限后停在 failed，并由手动重试恢复", async () => {
    api.getBatch.mockRejectedValue(new Error("offline"));
    await startRunningBatch();

    // 6 次失败：600 + 1200 + 2400 + 4800 + 5000 + 5000 的退避窗口。
    await vi.advanceTimersByTimeAsync(20_000);
    let state = useTransferStore.getState();
    expect(state.monitorState).toBe("failed");
    expect(state.monitorAttempts).toBe(6);
    expect(state.monitorError).toContain("offline");
    expect(state.activeBatch?.id).toBe("b9");
    const callsAfterGiveUp = api.getBatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.getBatch).toHaveBeenCalledTimes(callsAfterGiveUp);

    api.getBatch.mockResolvedValue(batch({ id: "b9", status: "running" }));
    useTransferStore.getState().retryBatchMonitor();
    await vi.advanceTimersByTimeAsync(0);
    state = useTransferStore.getState();
    expect(state.monitorState).toBe("polling");
    expect(state.monitorError).toBeNull();
  });

  it("终态到达即停止，不会继续查询", async () => {
    api.getBatch.mockResolvedValue(batch({ id: "b9", status: "completed", ok: 1 }));
    await startRunningBatch();
    await vi.advanceTimersByTimeAsync(2000);
    expect(useTransferStore.getState().monitorState).toBe("idle");
    const calls = api.getBatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.getBatch).toHaveBeenCalledTimes(calls);
  });
});
