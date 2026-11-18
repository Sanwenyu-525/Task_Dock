/**
 * @vitest-environment jsdom
 */
//! 后端任务等待语义：终态即返回、连续两次 NOT_FOUND 才判不可追踪、
//! 普通 IPC 抖动不算任务丢失，等待有上限。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors";

const mocks = vi.hoisted(() => ({
  fsJobCancel: vi.fn(),
  fsJobStatus: vi.fn(),
  fsJobReport: vi.fn(),
  fsJobs: vi.fn(),
  onRecycleJobProgress: vi.fn(),
}));

vi.mock("../bridge", () => ({
  fsJobCancel: mocks.fsJobCancel,
  fsJobStatus: mocks.fsJobStatus,
  fsJobReport: mocks.fsJobReport,
  fsJobs: mocks.fsJobs,
  onRecycleJobProgress: mocks.onRecycleJobProgress,
  isFileJobTerminal: (job: { status: string }) =>
    ["completed", "partial", "failed", "cancelled"].includes(job.status),
}));

import {
  cancelFileJob,
  registerFileJob,
  subscribeFileJobs,
  waitForFileJob,
} from "./fileJobs";

function snapshot(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    kind: "delete",
    status,
    total: 3,
    done: 3,
    ok: 2,
    failed: 1,
    skipped: 0,
    partial: 1,
    startedMs: Date.now() - 1,
    finishedMs: Date.now(),
    cancelable: false,
    cancelRequested: false,
    phase: "finishing",
    message: null,
    failures: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.fsJobCancel.mockReset();
  mocks.fsJobStatus.mockReset();
  mocks.fsJobReport.mockReset();
  mocks.fsJobs.mockReset().mockResolvedValue([]);
  mocks.onRecycleJobProgress.mockReset().mockResolvedValue(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForFileJob", () => {
  it("刚发起即终态的任务直接返回，不等 2.5s 轮询", async () => {
    registerFileJob(snapshot("completed", { id: "job-instant" }) as never);
    await expect(waitForFileJob("job-instant")).resolves.toMatchObject({ status: "completed" });
    expect(mocks.fsJobStatus).not.toHaveBeenCalled();
  });

  it("轮询到终态立即返回，不额外空转", async () => {
    mocks.fsJobStatus.mockResolvedValue(snapshot("partial", { id: "job-poll" }));
    const pending = waitForFileJob("job-poll");
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toMatchObject({ status: "partial", partial: 1 });
  });

  it("连续两次 NOT_FOUND 才判不可追踪，返回 null 而不是伪造成功", async () => {
    mocks.fsJobStatus.mockRejectedValue(
      new AppError("任务不存在或已过期", { code: "NOT_FOUND", category: "not_found" }),
    );
    const pending = waitForFileJob("job-missing");
    await vi.advanceTimersByTimeAsync(2600);
    // 单次 IPC 抖动不算任务丢失。
    await vi.advanceTimersByTimeAsync(2600);
    await expect(pending).resolves.toBeNull();
    expect(mocks.fsJobStatus).toHaveBeenCalledTimes(2);
  });

  it("普通 IPC 错误不冒充任务不存在，恢复后继续等待终态", async () => {
    mocks.fsJobStatus
      .mockRejectedValueOnce(new Error("IPC channel closed"))
      .mockResolvedValueOnce(snapshot("partial", { id: "job-transient" }));
    const pending = waitForFileJob("job-transient");
    await vi.advanceTimersByTimeAsync(2600);
    await vi.advanceTimersByTimeAsync(2600);
    await expect(pending).resolves.toMatchObject({ status: "partial" });
  });

  it("等待有上限：超过 30 分钟仍未终态时返回 null", async () => {
    mocks.fsJobStatus.mockResolvedValue(snapshot("running", { id: "job-long" }));
    const pending = waitForFileJob("job-long");
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 2600);
    await expect(pending).resolves.toBeNull();
  });
});

describe("订阅生命周期", () => {
  it("listen 在卸载后才返回：立即解除，不留下重复监听", async () => {
    const unlisten = vi.fn();
    let resolveListen!: (fn: () => void) => void;
    mocks.onRecycleJobProgress.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      }),
    );
    const unsubscribe = subscribeFileJobs(() => {});
    unsubscribe();
    resolveListen(unlisten);
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("cancelFileJob", () => {
  it("后端拒绝取消时返回 false，不假装已取消", async () => {
    mocks.fsJobCancel.mockResolvedValue(false);
    await expect(cancelFileJob("job-1")).resolves.toBe(false);
  });

  it("真实生效时返回 true", async () => {
    mocks.fsJobCancel.mockResolvedValue(true);
    await expect(cancelFileJob("job-1")).resolves.toBe(true);
  });
});
