//! 多目录搜索/重复查找纯逻辑：只搜选中目录、深度、类别/扩展名、大小预筛与哈希分组。

import { describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../bridge";

vi.mock("../bridge", () => ({
  fsListDir: vi.fn(),
  fsHashFiles: vi.fn(),
}));

import { fsHashFiles, fsListDir } from "../bridge";
import {
  hashDuplicateGroups,
  parseExtensions,
  searchWorkspace,
  sizeGroups,
} from "./workspaceSearch";

const list = vi.mocked(fsListDir);
const hash = vi.mocked(fsHashFiles);

function entry(name: string, kind: FsEntry["kind"], size = 10, category = "other"): FsEntry {
  return { name, kind, ext: name.split(".").pop()?.toLowerCase() ?? "", size, modifiedMs: 1000, hidden: false, category };
}

describe("searchWorkspace", () => {
  it("只在传入目录内递归，并应用类别/扩展名/深度", async () => {
    list.mockImplementation(async (path: string) => ({
      path,
      entries:
        path === "D:\\a"
          ? [entry("sub", "dir"), entry("x.png", "file", 10, "image"), entry("y.txt", "file", 10, "text")]
          : [entry("z.png", "file", 10, "image")],
      scanned: 3,
      hasMore: false,
    }));
    const result = await searchWorkspace(
      [{ paneId: "p1", label: "A", path: "D:\\a" }],
      { query: "x", extensions: ["png"], category: "image", modifiedWithinDays: null, maxDepth: 1, maxResults: 50, maxDirs: 10 },
    );
    expect(result.hits.map((hit) => hit.path)).toEqual(["D:\\a\\x.png"]);
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("parseExtensions", () => {
  it("接受逗号/空格/点前缀并去重", () => {
    expect(parseExtensions(".PNG, mp4;tsx png")).toEqual(["png", "mp4", "tsx"]);
  });
});

describe("duplicate", () => {
  it("大小预筛同大小组，哈希后只保留真正重复", async () => {
    const files = [
      { path: "D:\\a\\one.txt", dirPath: "D:\\a", paneId: "p1", paneLabel: "A", name: "one.txt", size: 10 },
      { path: "D:\\b\\two.txt", dirPath: "D:\\b", paneId: "p2", paneLabel: "B", name: "two.txt", size: 10 },
      { path: "D:\\b\\three.txt", dirPath: "D:\\b", paneId: "p2", paneLabel: "B", name: "three.txt", size: 10 },
      { path: "D:\\b\\other.txt", dirPath: "D:\\b", paneId: "p2", paneLabel: "B", name: "other.txt", size: 5 },
    ];
    const groups = sizeGroups(files);
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toHaveLength(3);
    hash.mockResolvedValue([
      { path: "D:\\a\\one.txt", size: 10, hash: "same", error: null },
      { path: "D:\\b\\two.txt", size: 10, hash: "same", error: null },
      { path: "D:\\b\\three.txt", size: 10, hash: "diff", error: null },
    ]);
    const confirmed = await hashDuplicateGroups(groups);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].hash).toBe("same");
    expect(confirmed[0].files.map((file) => file.name)).toEqual(["one.txt", "two.txt"]);
  });
});
