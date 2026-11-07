/** @vitest-environment jsdom */
//! 拖拽光标会话：起拖命中、原生相位代次、会话隔离与监听成对摘除。
//!
//! 重点是**原生结束信号**与**跨会话竞态**：Win32 模态移动循环期间 WebView2
//! 收不到指针事件，松手时不会派发 `pointerup`；同时结束事件是异步送达的，
//! 迟到的旧事件不得清掉刚开始的新会话。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const native = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  /**
   * 模拟原生窗口过程的状态：`generation` 是最近一次 `WM_ENTERSIZEMOVE` 的代次，
   * `active` 表示该移动循环此刻是否仍在运行（`WM_ENTERSIZEMOVE`…`WM_EXITSIZEMOVE`）。
   */
  const loop = { generation: 0, active: false };
  const queries: number[] = [];
  const state = { failQueries: false };
  return { handlers, loop, queries, state };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (payload: unknown) => void) => {
    native.handlers.set(name, cb);
    return Promise.resolve(() => native.handlers.delete(name));
  },
}));

// 预览/测试环境没有 Tauri 运行时，这里显式按「桌面端」安装桥。
// `drag_loop_active` 是前端关联 start 与本地会话的唯一原生查询。
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (command: string, args?: { generation?: number }) => {
    if (command !== "drag_loop_active") {
      return Promise.reject(new Error(`unexpected command: ${command}`));
    }
    if (native.state.failQueries) return Promise.reject(new Error("ipc unavailable"));
    const generation = args?.generation ?? -1;
    native.queries.push(generation);
    return Promise.resolve(native.loop.active && native.loop.generation === generation);
  },
}));

import {
  attachDragCursorSession,
  installNativeDragBridge,
  NATIVE_DRAG_EVENT,
  DRAG_SESSION_CLASS,
  __activeDragSessionCount,
  __resetDragBridgeStateForTests,
} from "./dragCursorSession";

function mountRoot() {
  const root = document.createElement("div");
  root.className = "ui-drag-session";
  root.innerHTML = `
    <span class="surface" data-tauri-drag-region>标题</span>
    <button type="button" class="action">按钮</button>
  `;
  document.body.appendChild(root);
  return root;
}

function surfaceOf(root: HTMLElement) {
  return root.querySelector(".surface") as HTMLElement;
}

function buttonOf(root: HTMLElement) {
  return root.querySelector(".action") as HTMLElement;
}

function dragging(root: HTMLElement) {
  return root.classList.contains(DRAG_SESSION_CLASS);
}

function press(target: HTMLElement, init: PointerEventInit = {}) {
  target.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, ...init }),
  );
}

function release(target: HTMLElement) {
  target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, buttons: 0 }));
}

function move(target: EventTarget, buttons: number) {
  target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons }));
}

/** 模拟原生窗口过程发出的相位事件（窗口级 emit 的载荷）。 */
function nativePhase(phase: "start" | "end", generation: number) {
  const handler = native.handlers.get(NATIVE_DRAG_EVENT);
  expect(handler).toBeTruthy();
  handler!({ event: NATIVE_DRAG_EVENT, id: 1, payload: { phase, generation } });
}

/** 模拟原生移动循环的实时状态（`WM_ENTERSIZEMOVE` / `WM_EXITSIZEMOVE`）。 */
function nativeLoop(generation: number, active: boolean) {
  native.loop.generation = generation;
  native.loop.active = active;
}

/**
 * 派发一次原生开始信号并等待关联查询结算。
 *
 * 查询走 `invoke` 的 Promise 链（纯微任务），这里按微任务冲刷到稳定，
 * 不使用定时器或随机延时。真实运行时查询在用户按住期间返回。
 */
async function nativeStart(generation: number) {
  nativePhase("start", generation);
  await flushNativeQueries();
}

async function flushNativeQueries() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

beforeAll(() => {
  installNativeDragBridge();
});

beforeEach(() => {
  native.queries.length = 0;
  native.state.failQueries = false;
  nativeLoop(0, false);
  __resetDragBridgeStateForTests();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("attachDragCursorSession", () => {
  it("只有带 drag-region 的元素能起拖，子按钮不参与", () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(buttonOf(root));
    expect(dragging(root)).toBe(false);

    press(surfaceOf(root));
    expect(dragging(root)).toBe(true);

    session.dispose();
    expect(__activeDragSessionCount()).toBe(0);
  });

  it("右键不起拖（只有主键才是窗口拖拽）", () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root), { button: 2, buttons: 2 });
    expect(dragging(root)).toBe(false);

    session.dispose();
  });

  it("pointerup 结束会话并回调状态", () => {
    const root = mountRoot();
    const states: boolean[] = [];
    const session = attachDragCursorSession(root, {
      onActiveChange: (active) => states.push(active),
    });

    press(surfaceOf(root));
    release(document.body);
    expect(dragging(root)).toBe(false);
    expect(states).toEqual([true, false]);

    session.dispose();
  });

  it("start/end 代次配对：原生循环结束即复位，鼠标不需要移动", async () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root));
    nativeLoop(1, true);
    await nativeStart(1);
    expect(dragging(root)).toBe(true);

    // 场景：用户按住拖动后松手，指针全程静止 → 没有任何 pointer 事件
    nativeLoop(1, false);
    nativePhase("end", 1);
    expect(dragging(root)).toBe(false);
    expect(__activeDragSessionCount()).toBe(0);

    session.dispose();
  });

  it("迟到的旧结束通知不得清理已经开始的新会话", async () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    // 第一次拖拽：正常收尾（pointerup 路径）
    press(surfaceOf(root));
    nativeLoop(1, true);
    await nativeStart(1);
    nativeLoop(1, false);
    release(document.body);
    expect(dragging(root)).toBe(false);

    // 第二次拖拽已经开始（代次尚未绑定），第一次的结束事件此刻才送达
    press(surfaceOf(root));
    expect(dragging(root)).toBe(true);
    nativePhase("end", 1);
    expect(dragging(root)).toBe(true);

    // 新循环自己的结束信号才生效
    nativeLoop(2, true);
    await nativeStart(2);
    nativeLoop(2, false);
    nativePhase("end", 2);
    expect(dragging(root)).toBe(false);

    session.dispose();
  });

  it("旧 start 与旧 end 都在新会话创建后才到达时，新会话必须存活", async () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    // 会话 A：按下后原生循环 1 已退出（例如消息队列堆积，A 也已按指针路径收尾）。
    press(surfaceOf(root));
    release(document.body);
    expect(dragging(root)).toBe(false);

    // 会话 B 已经开始按住；A 的 start(1)/end(1) 此刻才送达。
    press(surfaceOf(root));
    expect(dragging(root)).toBe(true);

    // 原生侧：循环 1 早已退出（B 自己的循环尚未开始或有别的代次）。
    nativeLoop(1, false);
    await nativeStart(1);
    // 这是本用例的核心：旧 start 不得把代次 1 绑定给 B。
    expect(dragging(root)).toBe(true);
    nativePhase("end", 1);
    expect(dragging(root)).toBe(true);
    expect(__activeDragSessionCount()).toBe(1);

    // B 收到自己的 start(2)/end(2) 后正常结束。
    nativeLoop(2, true);
    await nativeStart(2);
    nativeLoop(2, false);
    nativePhase("end", 2);
    expect(dragging(root)).toBe(false);
    expect(__activeDragSessionCount()).toBe(0);

    session.dispose();
  });

  it("关联查询只在原生循环仍活跃时绑定代次", async () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root));
    // 循环代次存在但已经退出：start 是旧消息，不得绑定。
    nativeLoop(7, false);
    await nativeStart(7);
    expect(native.queries).toContain(7);
    expect(dragging(root)).toBe(true);

    // 查询确认循环活跃时才绑定，之后 end(7) 才生效。
    nativeLoop(7, true);
    nativePhase("start", 7);
    await flushNativeQueries();
    nativeLoop(7, false);
    nativePhase("end", 7);
    expect(dragging(root)).toBe(false);

    session.dispose();
  });

  it("快速拖拽：end 先于查询结算时仍会正确收尾（不残留 grabbing）", async () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root));
    nativeLoop(3, true);
    nativePhase("start", 3); // 查询在循环活跃时受理
    nativeLoop(3, false);
    nativePhase("end", 3); // 结束信号先到（会话尚未绑定）

    await flushNativeQueries();
    // 查询结果确认这确实是本会话的循环：循环已结束，直接收尾，
    // 而不是把代次绑给一个永远等不到 pointerup 的会话。
    expect(dragging(root)).toBe(false);
    expect(__activeDragSessionCount()).toBe(0);

    session.dispose();
  });

  it("重复的 start 是幂等的（不会重复收尾或重复绑定）", async () => {
    const root = mountRoot();
    const states: boolean[] = [];
    const session = attachDragCursorSession(root, {
      onActiveChange: (active) => states.push(active),
    });

    press(surfaceOf(root));
    nativeLoop(1, true);
    await nativeStart(1);
    nativePhase("start", 1);
    await flushNativeQueries();
    expect(dragging(root)).toBe(true);

    nativeLoop(1, false);
    nativePhase("end", 1);
    nativePhase("end", 1);
    expect(dragging(root)).toBe(false);
    expect(states).toEqual([true, false]);
    expect(__activeDragSessionCount()).toBe(0);

    session.dispose();
  });

  it("原生查询不可用时退回指针事件兜底", async () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    native.state.failQueries = true;
    press(surfaceOf(root));
    nativeLoop(1, true);
    await nativeStart(1);
    // 无法确认归属时不绑定；用户松开左键后由 pointerup 收尾。
    expect(dragging(root)).toBe(true);

    nativeLoop(1, false);
    nativePhase("end", 1);
    expect(dragging(root)).toBe(true);

    release(document.body);
    expect(dragging(root)).toBe(false);

    session.dispose();
  });

  it("重复的结束通知是幂等的", async () => {
    const root = mountRoot();
    const states: boolean[] = [];
    const session = attachDragCursorSession(root, {
      onActiveChange: (active) => states.push(active),
    });

    press(surfaceOf(root));
    nativeLoop(1, true);
    await nativeStart(1);
    nativeLoop(1, false);
    nativePhase("end", 1);
    nativePhase("end", 1);
    nativePhase("end", 1);

    expect(dragging(root)).toBe(false);
    expect(states).toEqual([true, false]);
    expect(__activeDragSessionCount()).toBe(0);

    session.dispose();
  });

  it("相位乱序：先收到新 start，再收到旧 end，状态不被打乱", async () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root));
    nativeLoop(5, true);
    await nativeStart(5);
    // 旧代次的结束事件晚到
    nativePhase("end", 4);
    expect(dragging(root)).toBe(true);

    // 当前代次结束才复位
    nativeLoop(5, false);
    nativePhase("end", 5);
    expect(dragging(root)).toBe(false);

    session.dispose();
  });

  it("未绑定代次的会话不受原生结束信号影响（协议不完整时交给指针兜底）", () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root)); // 例如 startDragging 没走到原生循环
    nativePhase("end", 1);
    expect(dragging(root)).toBe(true);

    release(document.body);
    expect(dragging(root)).toBe(false);

    session.dispose();
  });

  it("起始扰动窗口内的 blur / 松开移动不复位，守卫期后恢复", () => {
    vi.useFakeTimers();
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root));
    move(window, 0);
    window.dispatchEvent(new Event("blur"));
    expect(dragging(root)).toBe(true);

    vi.advanceTimersByTime(200);
    move(window, 0);
    expect(dragging(root)).toBe(false);

    session.dispose();
  });

  it("连续多次拖拽后活动会话回到零，监听成对摘除", async () => {
    const root = mountRoot();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const session = attachDragCursorSession(root);

    for (let index = 0; index < 4; index += 1) {
      press(surfaceOf(root));
      expect(__activeDragSessionCount()).toBe(1);
      nativeLoop(index + 1, true);
      await nativeStart(index + 1);
      nativeLoop(index + 1, false);
      nativePhase("end", index + 1);
      expect(__activeDragSessionCount()).toBe(0);
    }

    expect(dragging(root)).toBe(false);
    expect(add.mock.calls.filter((c) => c[0] === "pointerup").length).toBe(4);
    expect(remove.mock.calls.filter((c) => c[0] === "pointerup").length).toBe(4);

    session.dispose();
  });

  it("新会话开始前彻底清理旧会话（不残留在活动集合）", () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root));
    // 旧会话没收到任何结束信号，直接开始下一次按下
    press(surfaceOf(root));
    expect(__activeDragSessionCount()).toBe(1);

    release(document.body);
    expect(__activeDragSessionCount()).toBe(0);

    session.dispose();
  });

  it("卸载/销毁后不再响应任何事件，也不残留类名与会话", async () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root));
    expect(dragging(root)).toBe(true);

    session.dispose();
    expect(dragging(root)).toBe(false);
    expect(__activeDragSessionCount()).toBe(0);

    press(surfaceOf(root));
    expect(dragging(root)).toBe(false);

    nativePhase("start", 9);
    await flushNativeQueries();
    // 没有存活会话时不发起关联查询，迟到的原生事件也不会写状态。
    expect(native.queries).toEqual([]);
    nativePhase("end", 9);
    expect(dragging(root)).toBe(false);
  });

  it("页面隐藏立即结束会话（窗口被隐藏时不留 grabbing）", () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(dragging(root)).toBe(false);
    expect(__activeDragSessionCount()).toBe(0);

    session.dispose();
  });
});
