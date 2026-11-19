//! 目录刷新唯一入口：并发合并、失败保留旧列表、乱序响应裁决。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeMocks = vi.hoisted(() => ({
  fsListDir: vi.fn(),
  fsDirSignature: vi.fn(),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);

import { getDirState, refreshDir } from "./dirCache";

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
let pending: Deferred[] = [];

beforeEach(() => {
  pending = [];
  bridgeMocks.fsListDir.mockReset();
  bridgeMocks.fsDirSignature.mockReset();
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
  bridgeMocks.fsListDir.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
});

afterEach(() => {
  for (const item of pending.splice(0)) {
    item.resolve({ path: "x", entries: [], hasMore: false, nextOffset: 0, scanned: 0 });
  }
  vi.restoreAllMocks();
});

function listing(path: string, names: string[]) {
  return {
    path,
    entries: names.map((name) => ({
      name,
      kind: "file" as const,
      ext: "txt",
      size: 1,
      modifiedMs: 1,
      hidden: false,
      category: "text",
    })),
    scanned: names.length,
    nextOffset: names.length,
    hasMore: false,
  };
}

const names = (path: string) => getDirState(path, false).listing?.map((entry) => entry.name);

describe("refreshDir", () => {
  it("立即进入 loading，成功后结束 loading 并更新列表", async () => {
    const path = "D:\\refresh-ok";
    const promise = refreshDir(path, false);
    // 同步阶段就必须能看到「正在刷新」，UI 旋转图标依赖这一点。
    expect(getDirState(path, false).loading).toBe(true);
    expect(getDirState(path, false).error).toBeNull();

    pending[0].resolve(listing(path, ["a.txt", "b.txt"]));
    await expect(promise).resolves.toBe(true);

    expect(getDirState(path, false).loading).toBe(false);
    expect(names(path)).toEqual(["a.txt", "b.txt"]);
  });

  it("失败时保留上一次成功列表，只写 error（不变空目录）", async () => {
    const path = "D:\\refresh-fail";
    const first = refreshDir(path, false);
    pending[0].resolve(listing(path, ["keep.txt"]));
    await first;

    const second = refreshDir(path, false);
    pending[1].reject(new Error("磁盘不可用"));
    await expect(second).resolves.toBe(false);

    expect(names(path)).toEqual(["keep.txt"]);
    expect(getDirState(path, false).error).toContain("磁盘不可用");
    expect(getDirState(path, false).loading).toBe(false);
  });

  it("同一路径并发刷新合并为同一个 Promise，只发一次 IPC", async () => {
    const path = "D:\\refresh-merge";
    const first = refreshDir(path, false);
    const second = refreshDir(path, false);
    expect(second).toBe(first);
    expect(bridgeMocks.fsListDir).toHaveBeenCalledTimes(1);

    pending[0].resolve(listing(path, ["only.txt"]));
    await expect(first).resolves.toBe(true);
    expect(names(path)).toEqual(["only.txt"]);
  });

  it("不同隐藏态是两份缓存，互不合并", async () => {
    const path = "D:\\refresh-hidden";
    const visible = refreshDir(path, false);
    const hidden = refreshDir(path, true);
    expect(visible).not.toBe(hidden);
    expect(bridgeMocks.fsListDir).toHaveBeenCalledTimes(2);

    pending[1].resolve(listing(path, ["h.txt"]));
    pending[0].resolve(listing(path, ["v.txt"]));
    await Promise.all([visible, hidden]);
    expect(names(path)).toEqual(["v.txt"]);
    expect(getDirState(path, true).listing?.map((entry) => entry.name)).toEqual(["h.txt"]);
  });

  it("旧刷新晚到不覆盖新刷新结果（序号裁决）", async () => {
    const path = "D:\\refresh-order";
    const older = refreshDir(path, false);
    const newer = refreshDir(path, false, true);
    expect(bridgeMocks.fsListDir).toHaveBeenCalledTimes(2);

    pending[1].resolve(listing(path, ["new.txt"]));
    await expect(newer).resolves.toBe(true);
    pending[0].resolve(listing(path, ["old.txt"]));
    await expect(older).resolves.toBe(false);

    expect(names(path)).toEqual(["new.txt"]);
    expect(getDirState(path, false).loading).toBe(false);
  });

  it("并发合并完成后可以再次刷新（映射不残留）", async () => {
    const path = "D:\\refresh-again";
    const first = refreshDir(path, false);
    pending[0].resolve(listing(path, ["one.txt"]));
    await first;

    const second = refreshDir(path, false);
    expect(second).not.toBe(first);
    pending[1].resolve(listing(path, ["two.txt"]));
    await expect(second).resolves.toBe(true);
    expect(names(path)).toEqual(["two.txt"]);
  });
});
