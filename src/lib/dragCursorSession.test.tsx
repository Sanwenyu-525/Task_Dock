/** @vitest-environment jsdom */
//! 拖拽光标会话：起拖命中、原生相位代次、会话隔离与监听成对摘除。
//!
//! 重点是**原生结束信号**与**跨会话竞态**：Win32 模态移动循环期间 WebView2
//! 收不到指针事件，松手时不会派发 `pointerup`；同时结束事件是异步送达的，
//! 迟到的旧事件不得清掉刚开始的新会话。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const native = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  return { handlers };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (payload: unknown) => void) => {
    native.handlers.set(name, cb);
    return Promise.resolve(() => native.handlers.delete(name));
  },
}));

// 预览/测试环境没有 Tauri 运行时，这里显式按「桌面端」安装桥。
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

import {
  attachDragCursorSession,
  installNativeDragBridge,
  NATIVE_DRAG_EVENT,
  DRAG_SESSION_CLASS,
  __activeDragSessionCount,
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

beforeAll(() => {
  installNativeDragBridge();
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

  it("start/end 代次配对：原生循环结束即复位，鼠标不需要移动", () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root));
    nativePhase("start", 1);
    expect(dragging(root)).toBe(true);

    // 场景：用户按住拖动后松手，指针全程静止 → 没有任何 pointer 事件
    nativePhase("end", 1);
    expect(dragging(root)).toBe(false);
    expect(__activeDragSessionCount()).toBe(0);

    session.dispose();
  });

  it("迟到的旧结束通知不得清理已经开始的新会话", () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    // 第一次拖拽：正常收尾（pointerup 路径）
    press(surfaceOf(root));
    nativePhase("start", 1);
    release(document.body);
    expect(dragging(root)).toBe(false);

    // 第二次拖拽已经开始（代次尚未绑定），第一次的结束事件此刻才送达
    press(surfaceOf(root));
    expect(dragging(root)).toBe(true);
    nativePhase("end", 1);
    expect(dragging(root)).toBe(true);

    // 新循环自己的结束信号才生效
    nativePhase("start", 2);
    nativePhase("end", 2);
    expect(dragging(root)).toBe(false);

    session.dispose();
  });

  it("重复的结束通知是幂等的", () => {
    const root = mountRoot();
    const states: boolean[] = [];
    const session = attachDragCursorSession(root, {
      onActiveChange: (active) => states.push(active),
    });

    press(surfaceOf(root));
    nativePhase("start", 1);
    nativePhase("end", 1);
    nativePhase("end", 1);
    nativePhase("end", 1);

    expect(dragging(root)).toBe(false);
    expect(states).toEqual([true, false]);
    expect(__activeDragSessionCount()).toBe(0);

    session.dispose();
  });

  it("相位乱序：先收到新 start，再收到旧 end，状态不被打乱", () => {
    const root = mountRoot();
    const session = attachDragCursorSession(root);

    press(surfaceOf(root));
    nativePhase("start", 5);
    // 旧代次的结束事件晚到
    nativePhase("end", 4);
    expect(dragging(root)).toBe(true);

    // 当前代次结束才复位
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

  it("连续多次拖拽后活动会话回到零，监听成对摘除", () => {
    const root = mountRoot();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const session = attachDragCursorSession(root);

    for (let index = 0; index < 4; index += 1) {
      press(surfaceOf(root));
      expect(__activeDragSessionCount()).toBe(1);
      nativePhase("start", index + 1);
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

  it("卸载/销毁后不再响应任何事件，也不残留类名与会话", () => {
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
