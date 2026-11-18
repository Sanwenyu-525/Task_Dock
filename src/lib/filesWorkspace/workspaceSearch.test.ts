//! 多目录搜索/重复查找纯逻辑：只搜选中目录、深度、类别/扩展名、大小预筛与哈希分组。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../bridge";

vi.mock("../bridge", () => ({
  fsListDir: vi.fn(),
  fsHashFiles: vi.fn(),
}));

import { fsHashFiles, fsListDir } from "../bridge";
import {
  collectWorkspaceFiles,
  hashDuplicateGroups,
  parseExtensions,
  searchWorkspace,
  sizeGroups,
  type SearchOptions,
} from "./workspaceSearch";

const list = vi.mocked(fsListDir);
const hash = vi.mocked(fsHashFiles);

beforeEach(() => {
  list.mockClear();
  hash.mockClear();
});

function entry(name: string, kind: FsEntry["kind"], size = 10, category = "other", hidden = false): FsEntry {
  return { name, kind, ext: name.split(".").pop()?.toLowerCase() ?? "", size, modifiedMs: 1000, hidden, category };
}

/** 构造一页后端载荷：nextOffset 为绝对磁盘偏移（契约 3）。 */
function page(entries: FsEntry[], nextOffset: number, hasMore = false) {
  return { path: "", entries, scanned: nextOffset, nextOffset, hasMore };
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
      nextOffset: 3,
      hasMore: false,
    }));
    const result = await searchWorkspace(
      [{ paneId: "p1", label: "A", path: "D:\\a" }],
      { query: "x", extensions: ["png"], category: "image", modifiedWithinDays: null, maxDepth: 1, maxResults: 50, maxDirs: 10 },
    );
    expect(result.hits.map((hit) => hit.path)).toEqual(["D:\\a\\x.png"]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(true);
  });

  it("文件夹名称也参与联合搜索，不被 query 排除", async () => {
    list.mockImplementation(async (path: string) => ({
      path,
      entries: [entry("Characters", "dir", 0, "folder"), entry("notes.txt", "file", 10, "text")],
      scanned: 2,
      nextOffset: 2,
      hasMore: false,
    }));
    const result = await searchWorkspace(
      [{ paneId: "p1", label: "A", path: "D:\\a" }],
      { query: "char", extensions: [], category: null, modifiedWithinDays: null, maxDepth: 0, maxResults: 50, maxDirs: 10 },
    );
    expect(result.hits.map((hit) => hit.entry.name)).toEqual(["Characters"]);
  });
});

it("目录超过单页时按 nextOffset 续拉，不遗漏第一页之后的条目", async () => {
  list.mockImplementation(async (_path: string, _showHidden: boolean, offset: number | undefined) => {
    if (offset === 0) return page([entry("a.png", "file", 10, "image")], 2, true);
    return page([entry("b.png", "file", 10, "image")], 3, false);
  });
  const result = await searchWorkspace(
    [{ paneId: "p1", label: "A", path: "D:\\a" }],
    { query: "", extensions: [], category: null, modifiedWithinDays: null, maxDepth: 0, maxResults: 50, maxDirs: 10 },
  );
  expect(result.hits.map((hit) => hit.path)).toEqual(["D:\\a\\a.png", "D:\\a\\b.png"]);
  expect(list).toHaveBeenNthCalledWith(1, "D:\\a", false, 0);
  expect(list).toHaveBeenNthCalledWith(2, "D:\\a", false, 2);
  expect(result.complete).toBe(true);
  expect(result.truncated).toBe(false);
});

it("重叠根产生的同路径命中只保留一条", async () => {
  list.mockImplementation(async (path: string) => ({
    path,
    entries: [entry("a.txt", "file", 10, "text")],
    scanned: 1,
    nextOffset: 1,
    hasMore: false,
  }));
  const result = await searchWorkspace(
    [
      { paneId: "p1", label: "A", path: "D:\\a" },
      { paneId: "p2", label: "B", path: "D:\\a" },
    ],
    { query: "", extensions: [], category: null, modifiedWithinDays: null, maxDepth: 0, maxResults: 50, maxDirs: 10 },
  );
  expect(result.hits.map((hit) => hit.path)).toEqual(["D:\\a\\a.txt"]);
});

const baseOpts = (over: Partial<SearchOptions> = {}): SearchOptions => ({
  query: "",
  extensions: [],
  category: null,
  modifiedWithinDays: null,
  maxDepth: 0,
  maxResults: 50,
  maxDirs: 10,
  ...over,
});

describe("searchWorkspace 分页完整性", () => {
  it("跨 100/7999/8000/8001/12000/16000/16001/24000/32000 边界多页遍历，命中集合不重不漏", async () => {
    const offsets = [0, 100, 7999, 8000, 8001, 12000, 16000, 16001, 24000, 32000];
    const nextOf = (i: number) => offsets[i + 1] ?? offsets[i] + 1;
    list.mockImplementation(async (_p: string, _h: boolean, offset: number | undefined) => {
      const i = offsets.indexOf(offset ?? 0);
      const entries = [entry(`f${offset}.png`, "file", 10, "image")];
      return page(entries, nextOf(i), i < offsets.length - 1);
    });
    const result = await searchWorkspace([{ paneId: "p1", label: "A", path: "D:\\big" }], baseOpts());
    expect(result.hits.map((hit) => hit.path)).toEqual(offsets.map((o) => `D:\\big\\f${o}.png`));
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
    expect(list).toHaveBeenCalledTimes(offsets.length);
  });

  it("中间页 hasMore=true 是正常分页，不置 truncated；连续多页后收敛为完整", async () => {
    list.mockImplementation(async (_p: string, _h: boolean, offset: number | undefined) => {
      if (offset === 0) return page([entry("a.txt", "file", 10, "text")], 2, true);
      return page([entry("b.txt", "file", 10, "text")], 3, false);
    });
    const result = await searchWorkspace([{ paneId: "p1", label: "A", path: "D:\\a" }], baseOpts());
    expect(result.hits.map((hit) => hit.path)).toEqual(["D:\\a\\a.txt", "D:\\a\\b.txt"]);
    expect(result.truncated).toBe(false);
    expect(result.complete).toBe(true);
  });

  it("命中结果达到 maxResults 上限：truncated=true 且 complete=false", async () => {
    list.mockResolvedValue(
      page([
        entry("a.txt", "file", 10, "text"),
        entry("b.txt", "file", 10, "text"),
        entry("c.txt", "file", 10, "text"),
      ], 3, false),
    );
    const result = await searchWorkspace([{ paneId: "p1", label: "A", path: "D:\\a" }], baseOpts({ maxResults: 2 }));
    expect(result.hits).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(false);
  });

  it("进入目录数达到 maxDirs 上限：truncated=true 且 complete=false", async () => {
    list.mockImplementation(async (_path: string) =>
      page([entry("x.txt", "file", 10, "text")], 1, false),
    );
    const result = await searchWorkspace(
      [
        { paneId: "p1", label: "A", path: "D:\\a" },
        { paneId: "p2", label: "B", path: "D:\\b" },
      ],
      baseOpts({ maxDirs: 1 }),
    );
    expect(result.dirsVisited).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(false);
  });

  it("开始前取消：cancelled=true，不发目录请求", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await searchWorkspace(
      [{ paneId: "p1", label: "A", path: "D:\\a" }],
      baseOpts(),
      undefined,
      controller.signal,
    );
    expect(result.cancelled).toBe(true);
    expect(result.complete).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it("翻页中取消：保留已命中结果，cancelled=true 且不再续拉", async () => {
    const controller = new AbortController();
    list.mockImplementation(async (_p: string, _h: boolean, offset: number | undefined) => {
      if (offset === 0) return page([entry("a.txt", "file", 10, "text")], 2, true);
      controller.abort();
      return page([entry("b.txt", "file", 10, "text")], 3, false);
    });
    const result = await searchWorkspace(
      [{ paneId: "p1", label: "A", path: "D:\\a" }],
      baseOpts(),
      undefined,
      controller.signal,
    );
    expect(result.hits.map((hit) => hit.path)).toEqual(["D:\\a\\a.txt"]);
    expect(result.cancelled).toBe(true);
    expect(result.complete).toBe(false);
  });

  it("分页停滞（hasMore 但 nextOffset 未推进）：truncated/complete=false，不重复请求同一页", async () => {
    list.mockImplementation(async (_p: string, _h: boolean, _offset: number | undefined) => {
      // 停滞：声明还有更多，但 nextOffset 停在 0。
      return page([entry("a.txt", "file", 10, "text")], 0, true);
    });
    const result = await searchWorkspace([{ paneId: "p1", label: "A", path: "D:\\a" }], baseOpts());
    expect(result.hits).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("翻页中目录变化产生重复路径：命中按路径去重，不重复入列", async () => {
    list.mockImplementation(async (_p: string, _h: boolean, offset: number | undefined) => {
      if (offset === 0) return page([entry("a.txt", "file", 10, "text")], 2, true);
      return page([entry("b.txt", "file", 10, "text"), entry("a.txt", "file", 10, "text")], 4, false);
    });
    const result = await searchWorkspace([{ paneId: "p1", label: "A", path: "D:\\a" }], baseOpts());
    expect(result.hits.map((hit) => hit.path)).toEqual(["D:\\a\\a.txt", "D:\\a\\b.txt"]);
    expect(result.complete).toBe(true);
  });

  it("搜索向后端请求 showHidden=false；隐藏项由后端过滤，前端按返回结果入列", async () => {
    // 隐藏项的偏移消耗与过滤语义属后端 list_dir 契约，在 Rust 测试覆盖；
    // 前端职责是把 showHidden=false 透传给后端，不二次自行过滤。
    list.mockResolvedValue(page([entry("visible.txt", "file", 10, "text")], 1, false));
    const result = await searchWorkspace([{ paneId: "p1", label: "A", path: "D:\\a" }], baseOpts());
    expect(list).toHaveBeenCalledWith("D:\\a", false, 0);
    expect(result.hits.map((hit) => hit.entry.name)).toEqual(["visible.txt"]);
    expect(result.complete).toBe(true);
  });

  it("includeHidden=true 时透传后端并保留隐藏项", async () => {
    list.mockResolvedValue(
      page([entry("visible.txt", "file", 10, "text"), entry("secret.txt", "file", 10, "text", true)], 2, false),
    );
    const result = await searchWorkspace(
      [{ paneId: "p1", label: "A", path: "D:\\a" }],
      baseOpts({ includeHidden: true }),
    );
    expect(list).toHaveBeenCalledWith("D:\\a", true, 0);
    expect(result.hits.map((hit) => hit.entry.name)).toEqual(["visible.txt", "secret.txt"]);
  });

  it("minSize/maxSize 过滤文件，目录不受大小限制", async () => {
    list.mockResolvedValue(
      page(
        [
          entry("dir", "dir", 0, "folder"),
          entry("small.txt", "file", 5, "text"),
          entry("mid.txt", "file", 50, "text"),
          entry("large.txt", "file", 500, "text"),
        ],
        4,
        false,
      ),
    );
    const result = await searchWorkspace(
      [{ paneId: "p1", label: "A", path: "D:\\a" }],
      baseOpts({ minSize: 10, maxSize: 100 }),
    );
    expect(result.hits.map((hit) => hit.entry.name)).toEqual(["dir", "mid.txt"]);
  });
});

describe("collectWorkspaceFiles 失败目录透传", () => {
  it("读取失败的目录计入 failedDirs 并随结果返回", async () => {
    list.mockImplementation(async (path: string) => {
      if (path === "D:\\bad") throw new Error("denied");
      return { path, entries: [entry("a.txt", "file", 10, "text")], scanned: 1, nextOffset: 1, hasMore: false };
    });
    const result = await collectWorkspaceFiles(
      [
        { paneId: "p1", label: "A", path: "D:\\bad" },
        { paneId: "p2", label: "B", path: "D:\\ok" },
      ],
      0,
    );
    expect(result.failedDirs).toBe(1);
    expect(result.files.map((file) => file.path)).toEqual(["D:\\ok\\a.txt"]);
    expect(result.complete).toBe(false);
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

  it("至少两个零字节文件可进入候选组，哈希仍会确认", async () => {
    const files = [
      { path: "D:\\a\\empty1.txt", dirPath: "D:\\a", paneId: "p1", paneLabel: "A", name: "empty1.txt", size: 0 },
      { path: "D:\\a\\empty2.txt", dirPath: "D:\\a", paneId: "p1", paneLabel: "A", name: "empty2.txt", size: 0 },
      { path: "D:\\a\\one.txt", dirPath: "D:\\a", paneId: "p1", paneLabel: "A", name: "one.txt", size: 0 },
    ];
    const groups = sizeGroups(files);
    expect(groups).toHaveLength(1);
    expect(groups[0].size).toBe(0);
    expect(groups[0].files).toHaveLength(3);
    hash.mockResolvedValue([
      { path: "D:\\a\\empty1.txt", size: 0, hash: "e3b0c442", error: null },
      { path: "D:\\a\\empty2.txt", size: 0, hash: "e3b0c442", error: null },
      { path: "D:\\a\\one.txt", size: 0, hash: "other", error: null },
    ]);
    const confirmed = await hashDuplicateGroups(groups);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].files.map((file) => file.name)).toEqual(["empty1.txt", "empty2.txt"]);
  });
});
