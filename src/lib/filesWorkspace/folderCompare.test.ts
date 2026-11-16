//! 文件夹对比：独有/大小/时间/内容哈希判定与安全复制方向。

import { describe, expect, it } from "vitest";
import type { FsEntry } from "../bridge";
import { applyHashesByPath, compareEntries, hashTargets } from "./folderCompare";

function file(name: string, size: number, modifiedMs: number): FsEntry {
  return { name, kind: "file", ext: name.split(".").pop() ?? "", size, modifiedMs, hidden: false, category: "other" };
}

function dir(name: string): FsEntry {
  return { name, kind: "dir", ext: "", size: null, modifiedMs: 0, hidden: false, category: "folder" };
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

  it("同名文件夹按单层比较标相同，不递归", () => {
    expect(compareEntries([dir("assets")], [dir("assets")])[0].status).toBe("same");
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
