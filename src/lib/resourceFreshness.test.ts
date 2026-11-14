/**
 * @vitest-environment node
 */
//! 资源快照有效性：按采样时间选最新、失败后不把历史读数伪装成当前。

import { describe, expect, it } from "vitest";
import type { ResourceSnapshot } from "./bridge";
import { hasReading, isCurrentReading, pickSnapshotView } from "./resourceFreshness";

function snap(sampledAt: string, cacheBytes = 1024): ResourceSnapshot {
  return {
    sampledAt,
    application: { knownCacheBytes: cacheBytes, knownCacheFiles: 1, status: "ready" },
    memory: { totalBytes: 1024, availableBytes: 512 },
    disks: [{ volume: "C:", kind: "fixed", totalBytes: 100, availableBytes: 40 }],
    process: {
      pid: 1,
      name: "task-dock.exe",
      cpuPercent: 1,
      cpuWindowMs: 200,
      workingSetBytes: 10,
      privateBytes: 5,
      uptimeSecs: 10,
      status: "normal",
    },
  };
}

describe("pickSnapshotView", () => {
  it("首次读取未完成：pending，无读数", () => {
    const view = pickSnapshotView({
      snapshot: null,
      loading: true,
      error: null,
      trendLatest: null,
    });
    expect(view.snapshot).toBeNull();
    expect(view.freshness).toBe("pending");
    expect(view.stale).toBe(false);
    expect(hasReading(view.freshness)).toBe(false);
  });

  it("正常成功：live，可称为当前读数", () => {
    const page = snap("2026-11-13T10:00:00.000Z");
    const view = pickSnapshotView({
      snapshot: page,
      loading: false,
      error: null,
      trendLatest: null,
    });
    expect(view.snapshot).toBe(page);
    expect(view.sampledAt).toBe("2026-11-13T10:00:00.000Z");
    expect(view.freshness).toBe("live");
    expect(isCurrentReading(view.freshness)).toBe(true);
  });

  it("刷新中保留上次成功读数：updating，仍是可展示数据但不是当前", () => {
    const view = pickSnapshotView({
      snapshot: snap("2026-11-13T10:00:00.000Z"),
      loading: true,
      error: null,
      trendLatest: null,
    });
    expect(view.freshness).toBe("updating");
    expect(hasReading(view.freshness)).toBe(true);
    expect(isCurrentReading(view.freshness)).toBe(false);
  });

  it("趋势采样比页面快照更新：选趋势末端", () => {
    const page = snap("2026-11-13T10:00:00.000Z", 1);
    const trend = snap("2026-11-13T10:00:10.000Z", 2);
    const view = pickSnapshotView({
      snapshot: page,
      loading: false,
      error: null,
      trendLatest: trend,
    });
    expect(view.snapshot).toBe(trend);
    expect(view.sampledAt).toBe("2026-11-13T10:00:10.000Z");
    expect(view.freshness).toBe("live");
  });

  it("页面快照比趋势更新：选页面快照", () => {
    const page = snap("2026-11-13T10:00:20.000Z", 3);
    const trend = snap("2026-11-13T10:00:10.000Z", 2);
    const view = pickSnapshotView({
      snapshot: page,
      loading: false,
      error: null,
      trendLatest: trend,
    });
    expect(view.snapshot).toBe(page);
  });

  it("刷新失败但趋势仍有旧读数：historical，绝不冒充当前", () => {
    const old = snap("2026-11-13T09:59:50.000Z");
    const view = pickSnapshotView({
      snapshot: null,
      loading: false,
      error: "IPC 失败",
      trendLatest: old,
    });
    expect(view.snapshot).toBe(old);
    expect(view.freshness).toBe("historical");
    expect(view.stale).toBe(true);
    expect(isCurrentReading(view.freshness)).toBe(false);
  });

  it("刷新失败且没有任何读数：failed", () => {
    const view = pickSnapshotView({
      snapshot: null,
      loading: false,
      error: "IPC 失败",
      trendLatest: null,
    });
    expect(view.snapshot).toBeNull();
    expect(view.freshness).toBe("failed");
    expect(view.stale).toBe(false);
  });

  it("非法/缺失采样时间不会被当成最新", () => {
    const valid = snap("2026-11-13T10:00:00.000Z", 1);
    const invalid = snap("not-a-date", 2);
    const view = pickSnapshotView({
      snapshot: invalid,
      loading: false,
      error: null,
      trendLatest: valid,
    });
    expect(view.snapshot).toBe(valid);
  });
});
