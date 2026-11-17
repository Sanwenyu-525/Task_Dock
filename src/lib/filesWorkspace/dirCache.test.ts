//! 目录缓存单测：乱序响应裁决（P0：强制刷新期间旧响应覆盖新响应）、
//! LRU 不驱逐订阅中的目录（P0：活跃视图永远收不到更新）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeMocks = vi.hoisted(() => ({
  fsListDir: vi.fn(),
  fsDirSignature: vi.fn(),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);

import {
  getDirState,
  loadDir,
  loadMore,
  reloadIfChanged,
  subscribeDir,
  invalidateDirs,
  PAGING_STALLED,
} from "./dirCache";

/** 受控的 fsListDir promise（测试手动 resolve/reject 模拟乱序）。 */
let pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];

beforeEach(() => {
  pending = [];
  bridgeMocks.fsListDir.mockImplementation(() => {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
});

afterEach(() => {
  // 放走挂起请求，防未处理拒绝。
  for (const p of pending.splice(0)) p.resolve({ path: "x", truncated: false, entries: [] });
  vi.restoreAllMocks();
});

function entry(name: string) {
  return {
    name,
    kind: "file" as const,
    ext: "txt",
    size: 1,
    modifiedMs: 1,
    hidden: false,
    category: "text",
  };
}

function listing(path: string, names: string[], hasMore = false, nextOffset?: number) {
  const scanned = nextOffset ?? names.length;
  return {
    path,
    entries: names.map(entry),
    scanned,
    nextOffset: scanned,
    hasMore,
  };
}

describe("loadDir 乱序裁决", () => {
  it("force 重载后旧响应后到不覆盖新列表（P0 乱序钉）", async () => {
    const path = "D:\\order-test";
    loadDir(path, false);
    expect(pending).toHaveLength(1);
    pending[0].resolve(listing(path, ["old-v1"]));
    await vi.waitFor(() => expect(getDirState(path, false).listing?.map((e) => e.name)).toEqual(["old-v1"]));

    // 外部变化触发强制重载；旧 promise 缓慢返回陈旧列表。
    loadDir(path, false, true);
    expect(pending).toHaveLength(2);
    // 先返回第 2 个（新请求，内容新）。
    pending[1].resolve(listing(path, ["new-v2"]));
    await vi.waitFor(() => expect(getDirState(path, false).listing?.map((e) => e.name)).toEqual(["new-v2"]));
    // 再返回第 1 个（旧请求，内容陈旧）→ 必须被序号裁决丢弃。
    pending[0].resolve(listing(path, ["old-v1"]));
    await Promise.resolve();
    expect(getDirState(path, false).listing?.map((e) => e.name)).toEqual(["new-v2"]);
  });

  it("错误响应同样按序号裁决", async () => {
    const path = "D:\\order-err";
    loadDir(path, false);
    loadDir(path, false, true);
    expect(pending).toHaveLength(2);
    pending[1].resolve(listing(path, ["good"]));
    await vi.waitFor(() => expect(getDirState(path, false).error).toBeNull());
    pending[0].reject(new Error("stale failure"));
    await Promise.resolve();
    // 旧请求的错误不影响已落地的最新列表。
    expect(getDirState(path, false).listing?.length).toBe(1);
    expect(getDirState(path, false).error).toBeNull();
  });
});

describe("LRU 与订阅", () => {
  it("订阅中的目录不被驱逐（P0：活跃视图卡死钉）", async () => {
    const paths = Array.from({ length: 40 }, (_, i) => `D:\\lru-${i}`);
    // 先加载并订阅最早的目录，再灌其余条目挤缓存（真实场景：活跃视图先存在）。
    loadDir(paths[0], false);
    pending.shift()!.resolve(listing(paths[0], [paths[0]]));
    await vi.waitFor(() => expect(getDirState(paths[0], false).listing).not.toBeNull());
    const seen: Array<string | null> = [];
    const unsub = subscribeDir(paths[0], false, (state) => seen.push(state.listing?.[0]?.name ?? null));
    for (let i = 1; i < paths.length; i += 1) {
      loadDir(paths[i], false);
      pending.shift()!.resolve(listing(paths[i], [paths[i]]));
    }
    await vi.waitFor(() => expect(pending).toHaveLength(0));
    // 订阅中的最早目录仍在缓存并可收到刷新通知。
    seen.length = 0;
    invalidateDirs([paths[0]]);
    pending[0]!.resolve(listing(paths[0], ["refreshed"]));
    await vi.waitFor(() => expect(seen).toContain("refreshed"));
    unsub();
  });

  it("无订阅条目正常按 LRU 驱逐", async () => {
    for (let i = 0; i < 40; i += 1) {
      const p = `D:\\lru-pure-${i}`;
      loadDir(p, false);
      pending.shift()!.resolve(listing(p, [p]));
    }
    await vi.waitFor(() => expect(pending).toHaveLength(0));
    // 最早的条目已被挤出（上限 32，灌 40 条后第一条不在）。
    expect(getDirState("D:\\lru-pure-0", false).listing).toBeNull();
  });
});

describe("目录签名轮询去重", () => {
  it("同一目录 3 秒内的重复探测只发一次 IPC", async () => {
    const path = "D:\\poll-dedupe";
    loadDir(path, false);
    pending.shift()!.resolve(listing(path, ["a"]));
    await vi.waitFor(() => expect(getDirState(path, false).listing).not.toBeNull());
    // 等首次签名回填完成，避免把「首次记录签名」算进本轮探测。
    await vi.waitFor(() => expect(getDirState(path, false).signatureModifiedMs).not.toBeNull());
    const before = bridgeMocks.fsDirSignature.mock.calls.length;
    // 多分栏 + 可见性回调在同一时刻触发：只允许一次探测。
    reloadIfChanged(path, false);
    reloadIfChanged(path, false);
    reloadIfChanged(path, false);
    await Promise.resolve();
    expect(bridgeMocks.fsDirSignature.mock.calls.length - before).toBe(1);
  });
});

describe("loadMore 翻页契约（nextOffset + 停滞保护）", () => {
  it("连续三页按 nextOffset 翻页，最终条目不重不漏、hasMore 收敛", async () => {
    const path = "D:\\multi-page";
    const plan: Record<number, { names: string[]; nextOffset: number; hasMore: boolean }> = {
      0: { names: ["a", "b"], nextOffset: 2, hasMore: true },
      2: { names: ["c", "d"], nextOffset: 4, hasMore: true },
      4: { names: ["e"], nextOffset: 5, hasMore: false },
    };
    bridgeMocks.fsListDir.mockImplementation(async (_p: string, _h: boolean, offset: number) => {
      const page = plan[offset];
      return listing(path, page.names, page.hasMore, page.nextOffset);
    });

    loadDir(path, false);
    await vi.waitFor(() => expect(getDirState(path, false).listing?.map((e) => e.name)).toEqual(["a", "b"]));
    expect(bridgeMocks.fsListDir).toHaveBeenNthCalledWith(1, path, false, 0);

    loadMore(path, false);
    await vi.waitFor(() =>
      expect(getDirState(path, false).listing?.map((e) => e.name)).toEqual(["a", "b", "c", "d"]),
    );
    expect(bridgeMocks.fsListDir).toHaveBeenNthCalledWith(2, path, false, 2);

    loadMore(path, false);
    await vi.waitFor(() =>
      expect(getDirState(path, false).listing?.map((e) => e.name)).toEqual(["a", "b", "c", "d", "e"]),
    );
    expect(bridgeMocks.fsListDir).toHaveBeenNthCalledWith(3, path, false, 4);

    const state = getDirState(path, false);
    expect(state.hasMore).toBe(false);
    expect(state.diskScanned).toBe(5);
  });

  it("跨 8000/16000/24000 边界的多页并集不重不漏", async () => {
    const path = "D:\\big-dir";
    const plan: Record<number, { names: string[]; nextOffset: number; hasMore: boolean }> = {
      0: { names: ["f0000"], nextOffset: 8000, hasMore: true },
      8000: { names: ["f8000"], nextOffset: 16000, hasMore: true },
      16000: { names: ["f16000"], nextOffset: 24000, hasMore: true },
      24000: { names: ["f24000"], nextOffset: 24001, hasMore: false },
    };
    bridgeMocks.fsListDir.mockImplementation(async (_p: string, _h: boolean, offset: number) => {
      const page = plan[offset];
      return listing(path, page.names, page.hasMore, page.nextOffset);
    });
    loadDir(path, false);
    await vi.waitFor(() => expect(getDirState(path, false).listing?.map((e) => e.name)).toEqual(["f0000"]));
    loadMore(path, false);
    await vi.waitFor(() => expect(getDirState(path, false).listing?.map((e) => e.name)).toContain("f8000"));
    loadMore(path, false);
    await vi.waitFor(() => expect(getDirState(path, false).listing?.map((e) => e.name)).toContain("f16000"));
    loadMore(path, false);
    await vi.waitFor(() => expect(getDirState(path, false).listing?.map((e) => e.name)).toContain("f24000"));
    const names = getDirState(path, false).listing!.map((e) => e.name);
    expect(names).toEqual(["f0000", "f8000", "f16000", "f24000"]);
    expect(getDirState(path, false).hasMore).toBe(false);
  });

  it("分页停滞（hasMore 但 nextOffset 未推进）置错误且不再发请求", async () => {
    const path = "D:\\stall";
    bridgeMocks.fsListDir.mockImplementation(async (_p: string, _h: boolean, _offset: number | undefined) => {
      // 首页正常；次页声明还有更多，但 nextOffset 停在 1（停滞）。
      return listing(path, ["a"], true, 1);
    });
    loadDir(path, false);
    await vi.waitFor(() => expect(getDirState(path, false).listing?.map((e) => e.name)).toEqual(["a"]));

    loadMore(path, false);
    await vi.waitFor(() => expect(getDirState(path, false).error).toBe(PAGING_STALLED));
    const state = getDirState(path, false);
    expect(state.hasMore).toBe(false);
    expect(state.listing?.map((e) => e.name)).toEqual(["a"]);

    const calls = bridgeMocks.fsListDir.mock.calls.length;
    loadMore(path, false);
    await Promise.resolve();
    expect(bridgeMocks.fsListDir.mock.calls.length).toBe(calls);
  });
});
