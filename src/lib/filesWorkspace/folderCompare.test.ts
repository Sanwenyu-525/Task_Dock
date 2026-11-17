//! 文件夹对比：独有/大小/时间/内容哈希判定与安全复制方向。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../bridge";

vi.mock("../bridge", () => ({
  fsListDir: vi.fn(),
  fsHashFiles: vi.fn(),
}));

import { fsListDir } from "../bridge";
import { applyHashesByPath, compareEntries, compareFolders, hashTargets, type CompareItem } from "./folderCompare";

const list = vi.mocked(fsListDir);

beforeEach(() => {
  list.mockReset();
});

/** 从对比项反推实际保留进左右两侧的条目总数。 */
function retainedCount(items: CompareItem[]): number {
  return items.reduce((sum, item) => sum + (item.left ? 1 : 0) + (item.right ? 1 : 0), 0);
}

function file(name: string, size: number, modifiedMs: number): FsEntry {
  return { name, kind: "file", ext: name.split(".").pop() ?? "", size, modifiedMs, hidden: false, category: "other" };
}

function dir(name: string): FsEntry {
  return { name, kind: "dir", ext: "", size: null, modifiedMs: 0, hidden: false, category: "folder" };
}

function listing(entries: FsEntry[], hasMore = false, nextOffset?: number) {
  const scanned = nextOffset ?? entries.length;
  return { path: "", entries, scanned, nextOffset: scanned, hasMore };
}

function mockTree(
  tree: Record<string, FsEntry[]>,
  hasMore: Record<string, boolean> = {},
  nextOffsets: Record<string, number> = {},
) {
  list.mockImplementation(async (path: string) =>
    listing(tree[path] ?? [], hasMore[path] ?? false, nextOffsets[path]),
  );
}

describe("compareEntries", () => {
  it("识别左右独有与同名大小差异", () => {
    const items = compareEntries([file("a.png", 10, 1), file("same.png", 10, 1)], [file("b.png", 20, 2), file("same.png", 11, 1)]);
    expect(items.find((item) => item.name === "a.png")?.status).toBe("leftOnly");
    expect(items.find((item) => item.name === "b.png")?.status).toBe("rightOnly");
    expect(items.find((item) => item.name === "same.png")?.status).toBe("sizeDiff");
  });

  it("同大小不同时间标记为待哈希", () => {
    const item = compareEntries([file("a.txt", 10, 1)], [file("a.txt", 10, 2)])[0];
    expect(item.status).toBe("timeDiff");
    expect(item.canHash).toBe(true);
  });

  it("同名文件夹在未检查内部内容时标 dirUnchecked，绝不直接标相同", () => {
    expect(compareEntries([dir("assets")], [dir("assets")])[0].status).toBe("dirUnchecked");
  });
});

describe("compareFolders 递归与完整性", () => {
  it("depth=0 只比较当前层，目录标未检查", async () => {
    mockTree({
      "D:\\L": [dir("assets"), file("a.txt", 10, 1)],
      "D:\\R": [dir("assets"), file("a.txt", 10, 2)],
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 0 });
    expect(result.complete).toBe(true);
    expect(result.items.find((item) => item.name === "assets")?.status).toBe("dirUnchecked");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("递归后同名目录可判定内容不同", async () => {
    mockTree({
      "D:\\L": [dir("assets")],
      "D:\\R": [dir("assets")],
      "D:\\L\\assets": [file("only-left.png", 10, 1)],
      "D:\\R\\assets": [file("only-right.png", 10, 1)],
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 1 });
    expect(result.items[0].status).toBe("dirDiff");
    expect(result.items[0].detail).toContain("assets/only-left.png");
    expect(result.complete).toBe(true);
    expect(result.dirsVisited).toBe(2);
    expect(result.filesScanned).toBe(4);
  });

  it("同名同大小同时间但未哈希时不能宣称目录内容相同", async () => {
    mockTree({
      "D:\\L": [dir("assets")],
      "D:\\R": [dir("assets")],
      "D:\\L\\assets": [file("a.txt", 10, 1)],
      "D:\\R\\assets": [file("a.txt", 10, 1)],
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 1 });
    expect(result.items[0].status).toBe("dirPartial");
  });

  it("空同名目录递归后可以确认一致；目录数上限命中时明确不完整", async () => {
    mockTree({
      "D:\\L": [dir("empty"), dir("empty2")],
      "D:\\R": [dir("empty"), dir("empty2")],
      "D:\\L\\empty": [],
      "D:\\R\\empty": [],
      "D:\\L\\empty2": [],
      "D:\\R\\empty2": [],
    });
    const same = await compareFolders("D:\\L", "D:\\R", { maxDepth: 1 });
    expect(same.items.find((item) => item.name === "empty")?.status).toBe("dirSame");
    expect(same.complete).toBe(true);

    const limited = await compareFolders("D:\\L", "D:\\R", { maxDepth: 1, maxDirs: 2 });
    expect(limited.complete).toBe(false);
    expect(limited.items.find((item) => item.name === "empty2")?.status).toBe("dirPartial");
  });

  it("文件数上限命中时结果不完整，不把未扫描内容当成相同", async () => {
    mockTree({
      "D:\\L": [file("a.txt", 10, 1), file("b.txt", 10, 1)],
      "D:\\R": [file("a.txt", 10, 1), file("b.txt", 10, 1)],
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 0, maxFiles: 3 });
    expect(result.complete).toBe(false);
  });

  it("递归 1 层且子目录仍有更深内容时，父子目录标未完整检查", async () => {
    mockTree({
      "D:\\L": [dir("assets")],
      "D:\\R": [dir("assets")],
      "D:\\L\\assets": [dir("deep")],
      "D:\\R\\assets": [dir("deep")],
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 1 });
    expect(result.items[0].status).toBe("dirPartial");
  });

  it("分页停滞（hasMore 但 nextOffset 未推进）时 complete=false，不能启用不可靠同步", async () => {
    // D:\L 首页声明还有更多，但 nextOffset 停在 0（停滞）：停止翻页并标记不完整。
    list.mockImplementation(async (path: string) => {
      if (path === "D:\\L") return listing([dir("assets"), file("left.txt", 10, 1)], true, 0);
      return listing([dir("assets")]);
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 1 });
    expect(result.complete).toBe(false);
    expect(result.limit).toBe("stalled");
    expect(result.items.find((item) => item.name === "left.txt")?.status).toBe("leftOnly");
  });

  it("单侧超过单页上限时双侧按 nextOffset 翻页读完，不漏项", async () => {
    const pages: Record<number, FsEntry[]> = {
      0: [file("a.txt", 10, 1), file("b.txt", 10, 1)],
      8000: [file("c.txt", 10, 1)],
    };
    list.mockImplementation(async (_path: string, _h: boolean, offset: number | undefined) => {
      const entries = pages[offset ?? 0] ?? [];
      const hasMore = offset === 0;
      return listing(entries, hasMore, offset === 0 ? 8000 : 8001);
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 0 });
    expect(result.complete).toBe(true);
    expect(result.items.map((item) => item.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
    // 左右两侧各翻两页。
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("目录读取失败计入 failedDirs 且结果不完整", async () => {
    list.mockImplementation(async (path: string) => {
      if (path === "D:\\R") throw new Error("denied");
      return listing([]);
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 1 });
    expect(result.complete).toBe(false);
    expect(result.failedDirs).toBe(1);
  });

  it("maxFiles 恰好等于两侧条目总数时完整，filesScanned 恰为上限", async () => {
    mockTree({
      "D:\\L": [file("a.txt", 10, 1), file("b.txt", 10, 1)],
      "D:\\R": [file("a.txt", 10, 1), file("b.txt", 10, 1)],
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 0, maxFiles: 4 });
    expect(result.complete).toBe(true);
    expect(result.limit).toBeNull();
    expect(result.filesScanned).toBe(4);
    expect(retainedCount(result.items)).toBe(4);
  });

  it("超一条：保留条目与 filesScanned 恰为 maxFiles，标记预算截断", async () => {
    mockTree({
      "D:\\L": [file("a.txt", 10, 1), file("b.txt", 10, 1)],
      "D:\\R": [file("a.txt", 10, 1), file("b.txt", 10, 1)],
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 0, maxFiles: 3 });
    expect(result.complete).toBe(false);
    expect(result.limit).toBe("budget");
    expect(result.filesScanned).toBe(3);
    expect(retainedCount(result.items)).toBe(3);
  });

  it("仅左侧超限：预算在左侧多页耗尽，右侧不再发 IPC", async () => {
    list.mockImplementation(async (path: string, _h: boolean, offset: number | undefined) => {
      if (path === "D:\\L") {
        if ((offset ?? 0) === 0) return listing([file("l1.txt", 10, 1), file("l2.txt", 10, 1)], true, 2);
        return listing([file("l3.txt", 10, 1), file("l4.txt", 10, 1)], false, 4);
      }
      return listing([file("r1.txt", 10, 1), file("r2.txt", 10, 1)]);
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 0, maxFiles: 3 });
    expect(result.complete).toBe(false);
    expect(result.limit).toBe("budget");
    expect(result.filesScanned).toBe(3);
    expect(retainedCount(result.items)).toBe(3);
    // 预算在左侧耗尽：右侧没有再收到任何 IPC。
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls.every((call) => call[0] === "D:\\L")).toBe(true);
    expect(result.items.every((item) => item.status === "leftOnly")).toBe(true);
  });

  it("仅右侧超限：左侧未用满，右侧第二页超预算并按绝对 offset 续拉", async () => {
    list.mockImplementation(async (path: string, _h: boolean, offset: number | undefined) => {
      if (path === "D:\\R") {
        if ((offset ?? 0) === 0) return listing([file("r1.txt", 10, 1)], true, 1);
        return listing([file("r2.txt", 10, 1), file("r3.txt", 10, 1)], false, 3);
      }
      return listing([file("l1.txt", 10, 1)]);
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 0, maxFiles: 3 });
    expect(result.complete).toBe(false);
    expect(result.limit).toBe("budget");
    expect(result.filesScanned).toBe(3);
    expect(retainedCount(result.items)).toBe(3);
    // 左侧 1 条 + 右侧 2 条；右侧共两页，第二页 offset 等于首页 nextOffset（绝对偏移）。
    expect(list).toHaveBeenCalledTimes(3);
    const rightCalls = list.mock.calls.filter((call) => call[0] === "D:\\R");
    expect(rightCalls).toHaveLength(2);
    expect(rightCalls[1][2]).toBe(1);
  });

  it("双侧条目均超预算：保留与记账有界，调用有界且同一 (路径,offset) 不重复", async () => {
    const leftPages: Record<number, FsEntry[]> = {
      0: [file("l1.txt", 10, 1), file("l2.txt", 10, 1), file("l3.txt", 10, 1)],
      3: [file("l4.txt", 10, 1), file("l5.txt", 10, 1), file("l6.txt", 10, 1)],
      6: [file("l7.txt", 10, 1)],
    };
    const rightPages: Record<number, FsEntry[]> = {
      0: [file("r1.txt", 10, 1), file("r2.txt", 10, 1), file("r3.txt", 10, 1)],
      3: [file("r4.txt", 10, 1), file("r5.txt", 10, 1), file("r6.txt", 10, 1)],
      6: [file("r7.txt", 10, 1)],
    };
    list.mockImplementation(async (path: string, _h: boolean, offset: number | undefined) => {
      const pages = path === "D:\\L" ? leftPages : rightPages;
      const entries = pages[offset ?? 0] ?? [];
      const hasMore = offset !== 6;
      return listing(entries, hasMore, offset === 0 ? 3 : offset === 3 ? 6 : 7);
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 0, maxFiles: 4 });
    expect(result.complete).toBe(false);
    expect(result.filesScanned).toBeLessThanOrEqual(4);
    expect(retainedCount(result.items)).toBeLessThanOrEqual(4);
    // 调用有界：不得出现无限翻页；同一 (路径, offset) 不重复请求。
    expect(list.mock.calls.length).toBeLessThanOrEqual(4);
    const pairs = list.mock.calls.map((call) => `${call[0]}@${String(call[2])}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    // 第二页 offset 等于首页 nextOffset（绝对偏移 3），而非自行累加。
    expect(list.mock.calls[1][2]).toBe(3);
  });

  it("第 2 页读取失败计入 failedDirs，失败侧不产出对比项", async () => {
    list.mockImplementation(async (path: string, _h: boolean, offset: number | undefined) => {
      if (path === "D:\\R") {
        if ((offset ?? 0) === 0) return listing([file("r1.txt", 10, 1)], true, 1);
        throw new Error("denied");
      }
      return listing([file("l1.txt", 10, 1)]);
    });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 0 });
    expect(result.complete).toBe(false);
    expect(result.limit).toBe("failed");
    expect(result.failedDirs).toBe(1);
    expect(result.filesScanned).toBe(2);
    // 失败的这一对目录不产出对比项，避免把“没读到”误报成仅一侧存在。
    expect(result.items).toHaveLength(0);
  });

  it("翻页续拉使用首页 nextOffset 绝对偏移，不自行累加", async () => {
    const pages: Record<number, FsEntry[]> = {
      0: [file("a.txt", 10, 1), file("b.txt", 10, 1)],
      5: [file("c.txt", 10, 1)],
    };
    list.mockImplementation(async (_path: string, _h: boolean, offset: number | undefined) => {
      const entries = pages[offset ?? 0] ?? [];
      const hasMore = offset === 0;
      return listing(entries, hasMore, 5);
    });
    await compareFolders("D:\\L", "D:\\R", { maxDepth: 0 });
    const offsets = list.mock.calls.map((call) => call[2]);
    expect(offsets[1]).toBe(5);
    expect(offsets).toContain(5);
  });

  it("取消后不再继续扫描，并标记 cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    mockTree({ "D:\\L": [dir("assets")], "D:\\R": [dir("assets")] });
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 2, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.complete).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("哈希合并", () => {
  it("同哈希判定内容一致，不同哈希判定内容不同", () => {
    const items = compareEntries(
      [file("same.txt", 10, 1), file("diff.txt", 10, 1)],
      [file("same.txt", 10, 2), file("diff.txt", 10, 2)],
    );
    const leftDir = "D:\\left";
    const rightDir = "D:\\right";
    const hashes = [
      { path: "D:\\left\\same.txt", size: 10, hash: "aaa", error: null },
      { path: "D:\\right\\same.txt", size: 10, hash: "aaa", error: null },
      { path: "D:\\left\\diff.txt", size: 10, hash: "aaa", error: null },
      { path: "D:\\right\\diff.txt", size: 10, hash: "bbb", error: null },
    ];
    const merged = applyHashesByPath(items, leftDir, rightDir, hashes);
    expect(merged.find((item) => item.name === "same.txt")?.status).toBe("contentSame");
    expect(merged.find((item) => item.name === "diff.txt")?.status).toBe("contentDiff");
  });

  it("哈希目标只包含同大小文件对", () => {
    const items = compareEntries([file("a.txt", 10, 1)], [file("a.txt", 10, 2)]);
    expect(hashTargets(items, "D:\\left", "D:\\right")).toEqual(["D:\\left\\a.txt", "D:\\right\\a.txt"]);
  });
});
