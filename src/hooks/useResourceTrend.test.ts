/**
 * @vitest-environment jsdom
 */
//! 短时趋势采样：有界、前台、失败不伪造、停止即停。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  TREND_CAPACITY,
  TREND_INTERVAL_MS,
  toTrendPoint,
  useResourceTrend,
} from "./useResourceTrend";
import type { ResourceSnapshot } from "../lib/bridge";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

function snapshot(
  sampledAt: string,
  options: { diskPercent?: number | null; memoryPercent?: number | null } = {},
): ResourceSnapshot {
  const { diskPercent = 50, memoryPercent = 40 } = options;
  return {
    sampledAt,
    application: { knownCacheBytes: 0, knownCacheFiles: 0, status: "ready" },
    memory: {
      totalBytes: 1000,
      availableBytes: memoryPercent === null ? null : 1000 - memoryPercent * 10,
    },
    disks: [
      {
        volume: "C:",
        kind: "fixed",
        totalBytes: 1000,
        availableBytes: diskPercent === null ? null : 1000 - diskPercent * 10,
      },
    ],
    process: {
      pid: 1,
      name: "task-dock.exe",
      cpuPercent: 0,
      cpuWindowMs: 0,
      workingSetBytes: 0,
      privateBytes: 0,
      uptimeSecs: 0,
      status: "normal",
    },
  };
}

function iso(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

/**
 * 只假造 interval：
 * - 同时伪造 setTimeout 会让 React 调度器的 0ms 任务在异步推进里反复排队；
 * - 用同步 `advanceTimersByTime` + 显式微任务 flush，避免
 *   `advanceTimersByTimeAsync` 与 React 调度互相等待导致用例挂起。
 */
function useIntervalTimers() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
}

/** 推进一个或多个采样周期，每个周期之间把 Promise 回调 flush 完。 */
async function advanceTicks(times: number, step = TREND_INTERVAL_MS) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      vi.advanceTimersByTime(step);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

describe("toTrendPoint", () => {
  it("磁盘取数据目录所在卷（首项），内存按同一公式计算", () => {
    const point = toTrendPoint(snapshot(iso(0), { diskPercent: 92.4, memoryPercent: 93.6 }));
    expect(point.diskPercent).toBeCloseTo(92.4, 3);
    expect(point.memoryPercent).toBeCloseTo(93.6, 3);
  });

  it("不可读读数保留 null，不变成 0%", () => {
    const point = toTrendPoint(snapshot(iso(0), { diskPercent: null, memoryPercent: null }));
    expect(point.diskPercent).toBeNull();
    expect(point.memoryPercent).toBeNull();
  });
});

describe("useResourceTrend", () => {
  it("seed 作为起点，挂载时不额外请求；一个周期后追加真实采样", async () => {
    useIntervalTimers();
    const sample = vi.fn().mockResolvedValue(snapshot(iso(10), { diskPercent: 51 }));
    const seed = snapshot(iso(0), { diskPercent: 50 });
    const { result } = renderHook(() =>
      useResourceTrend({ active: true, seed, sample, intervalMs: 10_000, capacity: 30 }),
    );

    expect(sample).not.toHaveBeenCalled();
    expect(result.current.points).toHaveLength(1);
    expect(result.current.points[0].diskPercent).toBeCloseTo(50, 3);
    expect(result.current.latest?.sampledAt).toBe(iso(0));

    await advanceTicks(1);

    expect(sample).toHaveBeenCalledTimes(1);
    expect(result.current.points).toHaveLength(2);
    expect(result.current.points[1].diskPercent).toBeCloseTo(51, 3);
    expect(result.current.latest?.sampledAt).toBe(iso(10));
    expect(result.current.failed).toBe(false);
  });

  it("环形缓冲有上限：超过容量只保留最近 N 个点", async () => {
    useIntervalTimers();
    let tick = 0;
    const sample = vi.fn().mockImplementation(() => {
      tick += 1;
      return Promise.resolve(snapshot(iso(tick), { diskPercent: 50 + tick }));
    });
    const { result } = renderHook(() =>
      useResourceTrend({ active: true, seed: snapshot(iso(0)), sample, intervalMs: 10_000, capacity: 3 }),
    );

    await advanceTicks(5);

    expect(sample).toHaveBeenCalledTimes(5);
    expect(result.current.points).toHaveLength(3);
    // 采样时间精确递增，且只保留最近 3 次（53/54/55 秒）
    expect(result.current.points.map((point) => point.sampledAt)).toEqual([
      iso(3),
      iso(4),
      iso(5),
    ]);
    expect(result.current.points[2].diskPercent).toBeCloseTo(55, 3);
  });

  it("失活（切到别的分区/停靠）后不再采样，重新激活才恢复", async () => {
    useIntervalTimers();
    const sample = vi.fn().mockResolvedValue(snapshot(iso(10)));
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useResourceTrend({ active, seed: snapshot(iso(0)), sample, intervalMs: 10_000 }),
      { initialProps: { active: false } },
    );

    await advanceTicks(3);
    expect(sample).not.toHaveBeenCalled();
    expect(result.current.points).toHaveLength(1);

    rerender({ active: true });
    await advanceTicks(1);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it("窗口隐藏时跳过采样，恢复可见后下一周期继续", async () => {
    useIntervalTimers();
    const sample = vi.fn().mockResolvedValue(snapshot(iso(10)));
    renderHook(() =>
      useResourceTrend({ active: true, seed: snapshot(iso(0)), sample, intervalMs: 10_000 }),
    );

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await advanceTicks(3);
    expect(sample).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await advanceTicks(1);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it("采样失败不写入数据点，标记 failed；下一次成功清除", async () => {
    useIntervalTimers();
    const sample = vi
      .fn()
      .mockRejectedValueOnce(new Error("ipc failed"))
      .mockResolvedValueOnce(snapshot(iso(20), { diskPercent: 52 }));
    const { result } = renderHook(() =>
      useResourceTrend({ active: true, seed: snapshot(iso(0)), sample, intervalMs: 10_000 }),
    );

    await advanceTicks(1);
    expect(result.current.failed).toBe(true);
    expect(result.current.points).toHaveLength(1);

    await advanceTicks(1);
    expect(result.current.failed).toBe(false);
    expect(result.current.points).toHaveLength(2);
    expect(result.current.points[1].diskPercent).toBeCloseTo(52, 3);
  });

  it("同一次后端读取（sampledAt 相同）只记一个点", async () => {
    useIntervalTimers();
    const seed = snapshot(iso(0));
    const sample = vi.fn().mockResolvedValue(seed);
    const { result } = renderHook(() =>
      useResourceTrend({ active: true, seed, sample, intervalMs: 10_000 }),
    );

    await advanceTicks(1);
    expect(result.current.points).toHaveLength(1);
  });

  it("卸载后定时器停止，迟到的采样不再写状态", async () => {
    useIntervalTimers();
    let resolveSample: ((value: ResourceSnapshot) => void) | null = null;
    const sample = vi.fn().mockImplementation(
      () =>
        new Promise<ResourceSnapshot>((resolve) => {
          resolveSample = resolve;
        }),
    );
    const { result, unmount } = renderHook(() =>
      useResourceTrend({ active: true, seed: snapshot(iso(0)), sample, intervalMs: 10_000 }),
    );

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(sample).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      resolveSample?.(snapshot(iso(10)));
      await Promise.resolve();
    });
    vi.advanceTimersByTime(30_000);

    expect(result.current.points).toHaveLength(1);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it("默认常量与文档一致：10 秒 / 30 点", () => {
    expect(TREND_INTERVAL_MS).toBe(10_000);
    expect(TREND_CAPACITY).toBe(30);
  });
});
