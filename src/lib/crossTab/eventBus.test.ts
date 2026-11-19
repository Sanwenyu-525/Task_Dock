//! 事件总线：一个事件只挂一个底层 listener；去重、竞态、卸载与异常隔离。
//!
//! 用可控的 `listen` mock 模拟「监听还在初始化」的窗口期，验证并发订阅、
//! 初始化中卸载、底层失败重试等真实竞态。

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  handlers: new Map<string, (message: { payload: unknown }) => void>(),
  pending: [] as Array<() => void>,
  listenCalls: [] as string[],
  failNext: false,
  unlistenCalls: 0,
};

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (message: { payload: unknown }) => void) => {
    state.listenCalls.push(event);
    if (state.failNext) {
      state.failNext = false;
      return Promise.reject(new Error("listen failed"));
    }
    return new Promise((resolve) => {
      state.handlers.set(event, handler);
      state.pending.push(() => resolve(() => {
        state.unlistenCalls += 1;
        state.handlers.delete(event);
      }));
    });
  },
}));

import {
  bridgeCount,
  hasPendingBridge,
  resetEventBusForTests,
  subscribe,
  subscriptionCount,
  unsubscribeModule,
} from "./eventBus";

function flush() {
  const queue = [...state.pending];
  state.pending = [];
  for (const resolve of queue) resolve();
  return Promise.resolve().then(() => undefined);
}

function emit(event: string, payload: unknown) {
  state.handlers.get(event)?.({ payload });
}

beforeEach(() => {
  resetEventBusForTests();
  state.handlers.clear();
  state.pending = [];
  state.listenCalls = [];
  state.failNext = false;
  state.unlistenCalls = 0;
});

describe("eventBus", () => {
  it("同一 handler 重复订阅只保留一个，事件只执行一次", async () => {
    const handler = vi.fn();
    subscribe("e1", handler, "m1");
    subscribe("e1", handler, "m1");
    await flush();
    expect(subscriptionCount()).toBe(1);
    expect(state.listenCalls.filter((e) => e === "e1")).toHaveLength(1);
    emit("e1", { n: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("两个模块订阅同一事件只建立一个底层 listener", async () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribe("e1", a, "m1");
    subscribe("e1", b, "m1");
    await flush();
    expect(bridgeCount()).toBe(1);
    expect(state.listenCalls.filter((e) => e === "e1")).toHaveLength(1);
    emit("e1", "x");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("并发初始化不会建立第二个 listener", async () => {
    subscribe("e1", vi.fn(), "m1");
    subscribe("e1", vi.fn(), "m2");
    // 初始化尚未完成时就有第二个订阅进来。
    expect(state.listenCalls.filter((e) => e === "e1")).toHaveLength(1);
    expect(hasPendingBridge("e1")).toBe(true);
    await flush();
    expect(hasPendingBridge("e1")).toBe(false);
    expect(state.listenCalls.filter((e) => e === "e1")).toHaveLength(1);
  });

  it("初始化中途卸载模块：监听建立后立刻注销，不留悬挂订阅", async () => {
    const handler = vi.fn();
    subscribe("e1", handler, "m1");
    unsubscribeModule("m1");
    expect(subscriptionCount()).toBe(0);
    await flush();
    expect(state.unlistenCalls).toBe(1);
    expect(bridgeCount()).toBe(0);
    emit("e1", "late");
    expect(handler).not.toHaveBeenCalled();
  });

  it("两个模块先后卸载：最后一个卸载才释放底层监听", async () => {
    subscribe("e1", vi.fn(), "m1");
    subscribe("e1", vi.fn(), "m2");
    await flush();
    unsubscribeModule("m1");
    expect(bridgeCount()).toBe(1);
    expect(state.unlistenCalls).toBe(0);
    unsubscribeModule("m2");
    expect(bridgeCount()).toBe(0);
    expect(state.unlistenCalls).toBe(1);
  });

  it("底层 listen 失败不抛出，后续订阅可以重试建链", async () => {
    state.failNext = true;
    const handler = vi.fn();
    expect(() => subscribe("e1", handler, "m1")).not.toThrow();
    await flush();
    expect(bridgeCount()).toBe(0);
    expect(subscriptionCount()).toBe(1);
    // 重试：新订阅重新建立 listener，之后事件可以送达两个订阅者。
    subscribe("e1", vi.fn(), "m2");
    await flush();
    expect(bridgeCount()).toBe(1);
    emit("e1", "ok");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("同一事件重复触发时每个订阅只执行一次（不会因多次订阅翻倍）", async () => {
    const handler = vi.fn();
    subscribe("e1", handler, "m1");
    subscribe("e1", handler, "m1");
    await flush();
    emit("e1", 1);
    emit("e1", 2);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("单个 handler 抛错不影响其他订阅者", async () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    subscribe("e1", bad, "m1");
    subscribe("e1", good, "m2");
    await flush();
    emit("e1", "x");
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
