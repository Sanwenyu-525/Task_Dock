/**
 * @vitest-environment jsdom
 */
//! OS 文件拖入的唯一订阅与所有权仲裁。
//!
//! 覆盖：单条 Webview 订阅、按优先级只选一个消费者、会话内不换人、
//! 无人认领不投递、注销后释放监听、物理像素→CSS 像素换算。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { payload: Record<string, unknown> }) => void;

const handlers: Handler[] = [];
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: Handler) => {
      handlers.push(cb);
      return Promise.resolve(unlisten);
    },
  }),
}));

import {
  __resetFileDrop,
  dropTargetAt,
  fileDropListening,
  registerFileDropConsumer,
  toCssPoint,
} from "./fileDrop";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function emit(payload: Record<string, unknown>): void {
  for (const h of handlers) h({ payload });
}

beforeEach(() => {
  handlers.length = 0;
  unlisten.mockClear();
  __resetFileDrop();
});

afterEach(() => {
  __resetFileDrop();
});

describe("fileDrop 分发", () => {
  it("只在有消费者时建立一条订阅，全部注销后立即释放", async () => {
    const a = registerFileDropConsumer({
      id: "a",
      priority: 1,
      claim: () => true,
      onDrop: () => {},
    });
    const b = registerFileDropConsumer({
      id: "b",
      priority: 2,
      claim: () => true,
      onDrop: () => {},
    });
    await flush();
    expect(handlers.length).toBe(1);
    expect(fileDropListening()).toBe(true);

    a();
    expect(fileDropListening()).toBe(true);
    b();
    expect(fileDropListening()).toBe(false);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("一次拖入只交给优先级最高的认领者，其余消费者收不到事件", async () => {
    const low = { enter: vi.fn(), drop: vi.fn() };
    const high = { enter: vi.fn(), drop: vi.fn() };
    registerFileDropConsumer({
      id: "shelf",
      priority: 10,
      claim: () => true,
      onEnter: low.enter,
      onDrop: low.drop,
    });
    registerFileDropConsumer({
      id: "capsule",
      priority: 20,
      claim: () => true,
      onEnter: high.enter,
      onDrop: high.drop,
    });
    await flush();

    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\\a.txt"] });

    expect(high.enter).toHaveBeenCalledTimes(1);
    expect(high.drop).toHaveBeenCalledTimes(1);
    expect(low.enter).not.toHaveBeenCalled();
    expect(low.drop).not.toHaveBeenCalled();
    expect(high.drop.mock.calls[0][0]).toEqual(["C:\\a.txt"]);
  });

  it("会话结束重新仲裁：上一轮的赢家不再认领时换人", async () => {
    let capsuleClaim = true;
    const shelfDrop = vi.fn();
    const capsuleDrop = vi.fn();
    registerFileDropConsumer({
      id: "shelf",
      priority: 10,
      claim: () => true,
      onDrop: shelfDrop,
    });
    registerFileDropConsumer({
      id: "capsule",
      priority: 20,
      claim: () => capsuleClaim,
      onDrop: capsuleDrop,
    });
    await flush();

    emit({ type: "enter", position: { x: 1, y: 1 }, paths: [] });
    emit({ type: "drop", position: { x: 1, y: 1 }, paths: ["C:\\1.txt"] });
    expect(capsuleDrop).toHaveBeenCalledTimes(1);

    capsuleClaim = false;
    emit({ type: "enter", position: { x: 1, y: 1 }, paths: [] });
    emit({ type: "drop", position: { x: 1, y: 1 }, paths: ["C:\\2.txt"] });
    expect(capsuleDrop).toHaveBeenCalledTimes(1);
    expect(shelfDrop).toHaveBeenCalledTimes(1);
  });

  it("无人认领时 drop 不触发任何消费者（fail-closed）", async () => {
    const drop = vi.fn();
    registerFileDropConsumer({
      id: "capsule",
      priority: 20,
      claim: () => false,
      onDrop: drop,
    });
    await flush();

    emit({ type: "enter", position: { x: 0, y: 0 }, paths: [] });
    emit({ type: "over", position: { x: 0, y: 0 } });
    emit({ type: "drop", position: { x: 0, y: 0 }, paths: ["C:\\x.txt"] });
    expect(drop).not.toHaveBeenCalled();
  });

  it("leave 会结束会话并回调复位", async () => {
    const leave = vi.fn();
    registerFileDropConsumer({
      id: "capsule",
      priority: 20,
      claim: () => true,
      onLeave: leave,
      onDrop: () => {},
    });
    await flush();
    emit({ type: "enter", position: { x: 0, y: 0 }, paths: [] });
    emit({ type: "leave" });
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("leave 之后即使松手也不再投递（不会在 drop 时重新认领）", async () => {
    const drop = vi.fn();
    registerFileDropConsumer({
      id: "capsule",
      priority: 20,
      claim: () => true,
      onDrop: drop,
    });
    await flush();
    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "leave" });
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\\a.txt"] });
    expect(drop).not.toHaveBeenCalled();
  });

  it("从未 enter 的 drop 不投递（没有会话就不猜消费者）", async () => {
    const drop = vi.fn();
    registerFileDropConsumer({
      id: "capsule",
      priority: 20,
      claim: () => true,
      onDrop: drop,
    });
    await flush();
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\\a.txt"] });
    expect(drop).not.toHaveBeenCalled();
  });

  it("缺少位置时把 null 交给 over/drop，由消费者拒绝", async () => {
    const over = vi.fn();
    const drop = vi.fn();
    registerFileDropConsumer({
      id: "capsule",
      priority: 20,
      claim: () => true,
      onOver: over,
      onDrop: drop,
    });
    await flush();
    emit({ type: "enter", paths: [] });
    emit({ type: "over" });
    expect(over).toHaveBeenLastCalledWith(null);
    emit({ type: "drop", paths: ["C:\\a.txt"] });
    expect(drop).toHaveBeenCalledWith(["C:\\a.txt"], null);
  });

  it("物理像素按 devicePixelRatio 换算成 CSS 像素", () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 1.25, configurable: true });
    expect(toCssPoint({ x: 250, y: 125 })).toEqual({ x: 200, y: 100 });
    Object.defineProperty(window, "devicePixelRatio", { value: original, configurable: true });
  });

  it("命中测试只认 data-drop-target 卡片", () => {
    const card = document.createElement("div");
    card.setAttribute("data-drop-target", "t-1");
    const child = document.createElement("span");
    card.appendChild(child);
    document.body.appendChild(card);
    const original = document.elementFromPoint;
    document.elementFromPoint = () => child;

    expect(dropTargetAt({ x: 1, y: 1 })).toBe("t-1");

    document.elementFromPoint = () => null;
    expect(dropTargetAt({ x: 1, y: 1 })).toBeNull();

    document.elementFromPoint = original;
    card.remove();
  });
});
