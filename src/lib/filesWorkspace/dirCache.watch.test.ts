// @vitest-environment jsdom
//! 目录监听事件 → 目录缓存重载：`ReadDirectoryChangesW` 的接线。
//!
//! 关键行为：外部程序**原地改写文件内容**不改变父目录 mtime，轮询看不出来；
//! 事件必须让**仍在订阅**的同一目录立即重载，未订阅的目录不产生 IPC。

import { beforeEach, describe, expect, it, vi } from "vitest";

const bridgeMocks = vi.hoisted(() => ({
  fsListDir: vi.fn(),
  fsDirSignature: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    eventMocks.handlers.set(name, handler);
    return eventMocks.listen(name, handler);
  },
}));

import {
  DIR_CHANGED_EVENT,
  loadDir,
  resetDirEventBridgeForTests,
  subscribeDir,
} from "./dirCache";

function listing(entries: Array<{ name: string }> = [{ name: "a.txt" }]) {
  return {
    entries: entries.map((entry) => ({
      name: entry.name,
      path: `D:\\Work\\${entry.name}`,
      isDir: false,
      size: 1,
      modifiedMs: 1,
      hidden: false,
    })),
    hasMore: false,
    nextOffset: entries.length,
    scanned: entries.length,
  };
}

/** 让 `loadDir` 的 then/finally 链跑完。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

beforeEach(() => {
  resetDirEventBridgeForTests();
  eventMocks.listen.mockReset();
  eventMocks.listen.mockImplementation(async () => () => {});
  eventMocks.handlers.clear();
  bridgeMocks.fsListDir.mockReset();
  bridgeMocks.fsListDir.mockResolvedValue(listing());
  bridgeMocks.fsDirSignature.mockReset();
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
});

describe("dirCache 目录变化事件", () => {
  it("订阅后事件到达即强制重载（签名不变也要重载）", async () => {
    const off = subscribeDir("D:\\Work", false, () => {});
    loadDir("D:\\Work", false);
    await flush();
    expect(bridgeMocks.fsListDir).toHaveBeenCalledTimes(1);

    const handler = eventMocks.handlers.get(DIR_CHANGED_EVENT);
    expect(handler).toBeTypeOf("function");
    // 大小写不同也必须匹配（Windows 路径大小写不敏感）。
    handler?.({ payload: { path: "d:\\work" } });
    await flush();

    expect(bridgeMocks.fsListDir).toHaveBeenCalledTimes(2);
    // 第二次必须是强制刷新（不因「正在加载」被去重掉）。
    expect(bridgeMocks.fsListDir).toHaveBeenLastCalledWith("D:\\Work", false, 0);
    off();
  });

  it("没有订阅者的目录收到事件不产生 IPC", async () => {
    // 只登记缓存、不订阅（模拟页面已离开但缓存还没被 LRU 淘汰）。
    loadDir("D:\\Detached", false);
    await flush();
    const before = bridgeMocks.fsListDir.mock.calls.length;

    eventMocks.handlers.get(DIR_CHANGED_EVENT)?.({ payload: { path: "D:\\Detached" } });
    await flush();

    expect(bridgeMocks.fsListDir).toHaveBeenCalledTimes(before);
  });

  it("同一目录短时间内的连续事件被合并", async () => {
    const off = subscribeDir("D:\\Burst", false, () => {});
    loadDir("D:\\Burst", false);
    await flush();
    const before = bridgeMocks.fsListDir.mock.calls.length;

    const handler = eventMocks.handlers.get(DIR_CHANGED_EVENT);
    handler?.({ payload: { path: "D:\\Burst" } });
    handler?.({ payload: { path: "D:\\Burst" } });
    handler?.({ payload: { path: "D:\\Burst" } });
    await flush();

    expect(bridgeMocks.fsListDir.mock.calls.length).toBe(before + 1);
    off();
  });

  it("事件通道不可用时退回轮询，不抛错", async () => {
    eventMocks.listen.mockRejectedValueOnce(new Error("no ipc"));
    const off = subscribeDir("D:\\NoEvent", false, () => {});
    await flush();
    // 订阅与加载照常工作。
    loadDir("D:\\NoEvent", false);
    await flush();
    expect(bridgeMocks.fsListDir).toHaveBeenCalled();
    off();
  });
});
