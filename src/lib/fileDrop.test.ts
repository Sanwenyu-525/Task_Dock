/**
 * @vitest-environment jsdom
 */
//! OS 文件拖入的唯一订阅与所有权仲裁。
//!
//! 覆盖：单条 Webview 订阅、按优先级只选一个消费者、会话内不换人、
//! 无人认领不投递、注销后释放监听、物理像素→CSS 像素换算。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticInput } from "./diagnostics";

type Handler = (event: { payload: Record<string, unknown> }) => void;

const handlers: Handler[] = [];
const unlisten = vi.fn();

/** 默认订阅成功；可观测性用例临时替换为 reject，验证失败路径。 */
let subscribeImpl: (() => Promise<() => void>) | null = null;

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: Handler) => {
      handlers.push(cb);
      return subscribeImpl ? subscribeImpl() : Promise.resolve(unlisten);
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
  subscribeImpl = null;
  __resetFileDrop();
});

afterEach(() => {
  subscribeImpl = null;
  __resetFileDrop();
  vi.restoreAllMocks();
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

  it("drop 后 owner 立即清空：同一会话重复 drop 只投递一次", async () => {
    const drop = vi.fn();
    registerFileDropConsumer({
      id: "capsule",
      priority: 20,
      claim: () => true,
      onDrop: drop,
    });
    await flush();
    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\\a.txt"] });
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\\a.txt"] });
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it("注销正在会话中的消费者：owner 立即清空并回调复位，迟到 drop 不再投递", async () => {
    const leave = vi.fn();
    const drop = vi.fn();
    const off = registerFileDropConsumer({
      id: "capsule",
      priority: 20,
      claim: () => true,
      onLeave: leave,
      onDrop: drop,
    });
    await flush();
    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "over", position: { x: 10, y: 10 } });

    off();
    expect(leave).toHaveBeenCalledTimes(1);

    // 会话已随注销结束：迟到的 drop 不得投给已注销的消费者
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

  it("enter 也把换算后的坐标交给认领者：静止拖入不依赖 over 才能高亮", async () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 1.25, configurable: true });
    const enter = vi.fn();
    registerFileDropConsumer({
      id: "capsule",
      priority: 20,
      claim: () => true,
      onEnter: enter,
      onDrop: () => {},
    });
    await flush();

    // OLE 只在鼠标移动时发 over；进入窗口那一刻的坐标是唯一能立即命中的机会。
    emit({ type: "enter", position: { x: 250, y: 125 }, paths: ["C:\\a.txt"] });
    expect(enter).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledWith({ x: 200, y: 100 });

    emit({ type: "enter", paths: [] });
    expect(enter).toHaveBeenLastCalledWith(null);

    Object.defineProperty(window, "devicePixelRatio", { value: original, configurable: true });
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

  it("命中测试支持 data-drop-zone 接收区（命中与未命中）", () => {
    const zone = document.createElement("div");
    zone.setAttribute("data-drop-zone", "shelf-recent");
    const child = document.createElement("span");
    zone.appendChild(child);
    document.body.appendChild(zone);
    const original = document.elementFromPoint;
    document.elementFromPoint = () => child;

    expect(dropTargetAt({ x: 5, y: 5 }, "data-drop-zone")).toBe("shelf-recent");
    // 默认属性只认投递卡片：接收区不会被当成卡片命中
    expect(dropTargetAt({ x: 5, y: 5 })).toBeNull();

    document.elementFromPoint = () => null;
    expect(dropTargetAt({ x: 5, y: 5 }, "data-drop-zone")).toBeNull();

    document.elementFromPoint = original;
    zone.remove();
  });
});

describe("监听失败可观测性", () => {
  it("订阅失败记录 WARN、5s 内去重、恢复后记录 recovered，且不泄漏路径", async () => {
    // 独立模块实例：诊断侧的去重窗口是模块级状态，不污染其它用例。
    vi.resetModules();
    const diag = await import("./diagnostics");
    const drop = await import("./fileDrop");
    const batches: DiagnosticInput[][] = [];
    diag.setDiagnosticTransport(async (events) => {
      batches.push([...events]);
    });
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    const secret = "C:\\secret\\private.txt";
    subscribeImpl = () =>
      Promise.reject(Object.assign(new Error(secret), { name: "PathError" }));

    const consumer = (id: string) => ({
      id,
      priority: 1,
      claim: () => true,
      onDrop: () => {},
    });
    const events = () => batches.flat();
    const failures = () =>
      events().filter((e) => e.event === "failed" && e.action === "file_drop_listener");

    const off1 = drop.registerFileDropConsumer(consumer("diag-1"));
    await flush();
    await flush();
    await diag.flushDiagnostics();

    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toMatchObject({
      level: "WARN",
      module: "file",
      stage: "subscribe",
      error_code: "FILE_DROP_LISTENER_FAILED",
    });
    // 异常 message 里带测试路径，但持久化事件只保留类型名，绝不带出路径。
    expect(JSON.stringify(events())).not.toContain("secret");
    expect(JSON.stringify(events())).not.toContain("private.txt");

    // 同一阶段 5s 内重复失败：去重，不逐次刷屏。
    const off2 = drop.registerFileDropConsumer(consumer("diag-2"));
    await flush();
    await flush();
    await diag.flushDiagnostics();
    expect(failures()).toHaveLength(1);

    // 超过去重窗口后再次失败：重新记录。
    now += 5_001;
    const off3 = drop.registerFileDropConsumer(consumer("diag-3"));
    await flush();
    await flush();
    await diag.flushDiagnostics();
    expect(failures()).toHaveLength(2);

    // 订阅恢复：仅在失败过之后补一条 recovered。
    subscribeImpl = null;
    const off4 = drop.registerFileDropConsumer(consumer("diag-4"));
    await flush();
    await flush();
    await diag.flushDiagnostics();
    expect(events().filter((e) => e.event === "recovered")).toHaveLength(1);

    // 退订失败：记录 unlisten 阶段，仍然不抛、不泄漏路径。
    unlisten.mockImplementationOnce(() => {
      throw new Error(secret);
    });
    off1();
    off2();
    off3();
    off4(); // 最后一个消费者 → releaseListener → unlisten 抛错
    await flush();
    await diag.flushDiagnostics();
    expect(failures().filter((e) => e.stage === "unlisten")).toHaveLength(1);
    expect(JSON.stringify(events())).not.toContain("private.txt");

    diag.setDiagnosticTransport(null);
    nowSpy.mockRestore();
  });
});
