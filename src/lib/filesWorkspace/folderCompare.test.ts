//! 文件夹对比：独有/大小/时间/内容哈希判定与安全复制方向。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../bridge";

vi.mock("../bridge", () => ({
  fsListDir: vi.fn(),
  fsHashFiles: vi.fn(),
}));

import { fsListDir } from "../bridge";
import { applyHashesByPath, compareEntries, compareFolders, hashTargets } from "./folderCompare";

const list = vi.mocked(fsListDir);

beforeEach(() => {
  list.mockReset();
});

function file(name: string, size: number, modifiedMs: number): FsEntry {
  return { name, kind: "file", ext: name.split(".").pop() ?? "", size, modifiedMs, hidden: false, category: "other" };
}

function dir(name: string): FsEntry {
  return { name, kind: "dir", ext: "", size: null, modifiedMs: 0, hidden: false, category: "folder" };
}

function listing(entries: FsEntry[], hasMore = false) {
  return { path: "", entries, scanned: entries.length, hasMore };
}

function mockTree(tree: Record<string, FsEntry[]>, hasMore: Record<string, boolean> = {}) {
  list.mockImplementation(async (path: string) => listing(tree[path] ?? [], hasMore[path] ?? false));
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
    expect(result.complete).toBe(true);
    expect(result.dirsVisited).toBe(2);
    expect(result.filesScanned).toBe(4);
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

  it("目录列表被截断时 complete=false，不能启用不可靠同步", async () => {
    mockTree(
      {
        "D:\\L": [dir("assets"), file("left.txt", 10, 1)],
        "D:\\R": [dir("assets")],
      },
      { "D:\\L": true },
    );
    const result = await compareFolders("D:\\L", "D:\\R", { maxDepth: 1 });
    expect(result.complete).toBe(false);
    expect(result.items.find((item) => item.name === "left.txt")?.status).toBe("leftOnly");
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
