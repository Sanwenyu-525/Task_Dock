/** @vitest-environment jsdom */
//! 工具面板标题的拖拽热区契约（五个面板共用 `PanelKit.PanelHead`）。
//!
//! 胶囊与工具面板在同一个原生窗口里：从标题背景/文字起拖 = 拖动整个窗口，
//! 轨道与面板因此不可能分离。这里锁定的是**命中范围**：
//! - 标题背景、标题文字、说明文字都带 `data-tauri-drag-region`；
//! - `actions` 里的返回/刷新/新建等控件一律不带，永远不误触发拖动。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PanelHead } from "./PanelKit";
import { installNativeDragBridge, NATIVE_DRAG_EVENT } from "../../lib/dragCursorSession";

const native = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  loop: { generation: 0, active: false },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (payload: unknown) => void) => {
    native.handlers.set(name, cb);
    return Promise.resolve(() => native.handlers.delete(name));
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  // start 的会话关联会查询原生循环是否仍在运行。
  invoke: (command: string, args?: { generation?: number }) =>
    Promise.resolve(
      command === "drag_loop_active" &&
        native.loop.active &&
        native.loop.generation === args?.generation,
    ),
}));

installNativeDragBridge();

afterEach(() => cleanup());

/** 冲刷关联查询的微任务链（不使用定时器）。 */
async function flushNative() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function phase(phaseName: "start" | "end", generation: number) {
  const handler = native.handlers.get(NATIVE_DRAG_EVENT);
  expect(handler).toBeTruthy();
  handler!({ event: NATIVE_DRAG_EVENT, id: generation, payload: { phase: phaseName, generation } });
}

function renderHead() {
  const view = render(
    <PanelHead
      title="任务"
      sub="今天要做的"
      actions={
        <button type="button" aria-label="刷新">
          刷新
        </button>
      }
    />,
  );
  const head = view.container.querySelector(".cap-head") as HTMLElement;
  const text = view.container.querySelector(".cap-head-text") as HTMLElement;
  const title = view.container.querySelector(".cap-title") as HTMLElement;
  const sub = view.container.querySelector(".cap-sub") as HTMLElement;
  const action = screen.getByRole("button", { name: "刷新" });
  return { view, head, text, title, sub, action };
}

function press(target: HTMLElement) {
  fireEvent.pointerDown(target, { button: 0, buttons: 1 });
}

describe("PanelHead 拖拽热区", () => {
  it("标题背景与两段文字都是拖拽热区", () => {
    const { head, text, title, sub } = renderHead();
    // Tauri 只认事件 target 自身的属性：背景、文字容器、标题、说明都要挂
    expect(head.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(text.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(title.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(sub.hasAttribute("data-tauri-drag-region")).toBe(true);
    // 光标语义：整块标题可抓
    expect(head.classList.contains("ui-drag-surface")).toBe(true);
    expect(head.classList.contains("ui-drag-session")).toBe(true);
  });

  it("操作区按钮不是拖拽热区，按下不进入拖动", () => {
    const { head, action } = renderHead();
    // 祖先带属性不影响子孙：Tauri 只看事件 target 自身
    expect(action.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(action.parentElement?.classList.contains("cap-actions")).toBe(true);

    press(action);
    expect(head.classList.contains("is-dragging")).toBe(false);

    press(head.querySelector(".cap-title") as HTMLElement);
    expect(head.classList.contains("is-dragging")).toBe(true);
  });

  it("原生移动循环结束后标题区立即退出 dragging（松手不需要再移动鼠标）", async () => {
    const { head, title } = renderHead();
    press(title);
    expect(head.classList.contains("is-dragging")).toBe(true);

    // 原生相位事件带代次：start 在循环活跃时绑定、end 收尾，与拖拽会话一一对应
    native.loop = { generation: 3, active: true };
    phase("start", 3);
    await flushNative();
    expect(head.classList.contains("is-dragging")).toBe(true);
    native.loop.active = false;
    phase("end", 3);
    expect(head.classList.contains("is-dragging")).toBe(false);

    // 迟到的旧代次结束事件不清掉新会话；新循环 start/end 才收尾
    press(title);
    phase("end", 3);
    expect(head.classList.contains("is-dragging")).toBe(true);
    native.loop = { generation: 4, active: true };
    phase("start", 4);
    await flushNative();
    native.loop.active = false;
    phase("end", 4);
    expect(head.classList.contains("is-dragging")).toBe(false);
  });

  it("说明文字里允许放按钮（sub 可传节点），按钮不吞掉拖拽热区、也不被拖拽抢占", () => {
    const onClick = vi.fn();
    const view = render(
      <PanelHead title="任务" sub={<button type="button" onClick={onClick}>重试</button>} />,
    );
    const head = view.container.querySelector(".cap-head") as HTMLElement;
    const btn = screen.getByRole("button", { name: "重试" });

    press(btn);
    expect(head.classList.contains("is-dragging")).toBe(false);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
