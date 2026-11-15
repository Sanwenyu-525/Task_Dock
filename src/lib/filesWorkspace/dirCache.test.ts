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
  subscribeDir,
  invalidateDirs,
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

function listing(path: string, names: string[]) {
  return {
    path,
    truncated: false,
    entries: names.map((n) => ({
      name: n,
      kind: "file",
      ext: "txt",
      size: 1,
      modifiedMs: 1,
      hidden: false,
      category: "text",
    })),
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
