//! 跨目录传输契约：冲突预检、成功项清理、刷新目录、F5/F6 目标选择。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/bridge", () => ({
  fsStat: vi.fn(),
}));

import { fsStat } from "../../lib/bridge";
import {
  detectTransferConflicts,
  movedSourcesToClear,
  pickAutomaticTarget,
  transferRefreshDirs,
} from "./transfer";

const stat = vi.mocked(fsStat);

beforeEach(() => {
  stat.mockReset();
});

describe("detectTransferConflicts", () => {
  it("只返回目标已存在的项，并带目标类型", async () => {
    stat.mockResolvedValue([
      { path: "D:\\b\\a.txt", exists: true, kind: "file" } as never,
      { path: "D:\\b\\b.txt", exists: false, kind: "missing" } as never,
    ]);
    const conflicts = await detectTransferConflicts(["D:\\a\\a.txt", "D:\\a\\b.txt"], "D:\\b");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].source).toBe("D:\\a\\a.txt");
    expect(conflicts[0].target).toBe("D:\\b\\a.txt");
    expect(conflicts[0].targetKind).toBe("file");
  });

  it("自身/同目录投递在预检前被拒绝，不发 IPC", async () => {
    const conflicts = await detectTransferConflicts(["D:\\a\\same.txt"], "D:\\a");
    expect(conflicts).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
  });

  it("超过 100 项时按批查询", async () => {
    stat.mockResolvedValue([]);
    const paths = Array.from({ length: 205 }, (_, index) => `D:\\a\\f${index}.txt`);
    await detectTransferConflicts(paths, "D:\\b");
    expect(stat).toHaveBeenCalledTimes(3);
  });
});

describe("移动成功后的来源清理", () => {
  it("只清除 ok 项；失败/partial 保留选择", () => {
    const report = {
      operationId: "op",
      attempted: 3,
      ok: 1,
      failed: 1,
      skipped: 0,
      partial: 1,
      entries: [
        { source: "D:\\a\\ok.txt", target: "D:\\b\\ok.txt", status: "ok" as const, reason: null },
        { source: "D:\\a\\fail.txt", target: null, status: "failed" as const, reason: "权限" },
        { source: "D:\\a\\partial.txt", target: "D:\\b\\partial.txt", status: "partial" as const, reason: "源未删" },
      ],
    };
    expect(movedSourcesToClear(report)).toEqual(["D:\\a\\ok.txt"]);
  });
});

describe("刷新目录集合", () => {
  it("目标目录 + 所有源父目录，去重且不丢大小写", () => {
    const dirs = transferRefreshDirs(["D:\\a\\x.txt", "D:\\a\\sub\\y.txt", "C:\\c\\z.txt"], "D:\\b");
    expect(dirs).toContain("D:\\b");
    expect(dirs).toContain("D:\\a");
    expect(dirs).toContain("D:\\a\\sub");
    expect(dirs).toContain("C:\\c");
    expect(new Set(dirs.map((dir) => dir.toLowerCase())).size).toBe(dirs.length);
  });
});

describe("F5/F6 目标选择", () => {
  const paneIds = ["p1", "p2", "p3"];
  it("只有一个其他窗格时直接选中", () => {
    expect(pickAutomaticTarget({ sourcePaneId: "p1", paneIds: ["p1", "p2"], lastTargetPaneId: null })).toEqual({
      paneId: "p2",
      needsPicker: false,
    });
  });
  it("多窗格优先上次目标", () => {
    expect(pickAutomaticTarget({ sourcePaneId: "p1", paneIds, lastTargetPaneId: "p3" })).toEqual({
      paneId: "p3",
      needsPicker: false,
    });
  });
  it("多窗格无上次目标时要求选择器", () => {
    expect(pickAutomaticTarget({ sourcePaneId: "p1", paneIds, lastTargetPaneId: null })).toEqual({
      paneId: null,
      needsPicker: true,
    });
  });
  it("只剩当前窗格时返回 null", () => {
    expect(pickAutomaticTarget({ sourcePaneId: "p1", paneIds: ["p1"], lastTargetPaneId: null })).toEqual({
      paneId: null,
      needsPicker: false,
    });
  });
});
