/**
 * @vitest-environment jsdom
 */
//! 暂存架矩形框选：阈值、坐标、命中、XOR、取消、自动滚动与清理。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useShelfMarquee,
  type ShelfMarqueeMode,
  type ShelfMarqueeRect,
} from "./useShelfMarquee";

type ChangeHandler = (
  ids: string[],
  mode: ShelfMarqueeMode,
  phase: "move" | "end",
) => void;

interface HarnessApi {
  active: boolean;
  rect: ShelfMarqueeRect | null;
  shouldSuppressClick: () => boolean;
}

interface HarnessProps {
  apiRef: { current: HarnessApi | null };
  onChange: ChangeHandler;
  onCancel?: () => void;
  getBaseSelection?: () => string[];
}

function Harness({ apiRef, onChange, onCancel, getBaseSelection }: HarnessProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const marquee = useShelfMarquee({
    containerRef,
    enabled: true,
    onChange,
    onCancel,
    getBaseSelection,
  });
  apiRef.current = {
    active: marquee.active,
    rect: marquee.rect,
    shouldSuppressClick: marquee.shouldSuppressClick,
  };
  return (
    <div
      ref={containerRef}
      data-testid="container"
      onPointerDown={marquee.onPointerDown}
    >
      <div data-shelf-id="a" data-testid="item-a">
        <span data-testid="item-a-label">A</span>
      </div>
      <div data-shelf-id="b" data-testid="item-b">B</div>
      <div data-shelf-id="c" data-testid="item-c">C</div>
      <div data-shelf-id="d" data-testid="item-d">D</div>
      <button type="button" data-testid="action">操作</button>
      <div data-testid="no-drag" data-no-drag>不参与</div>
      {marquee.rect && (
        <div
          data-testid="overlay"
          data-left={marquee.rect.left}
          data-top={marquee.rect.top}
          data-width={marquee.rect.width}
          data-height={marquee.rect.height}
          data-active={String(marquee.active)}
        />
      )}
    </div>
  );
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const ITEM_RECTS: Record<string, [number, number, number, number]> = {
  a: [120, 80, 100, 60],
  b: [240, 80, 100, 60],
  c: [120, 160, 100, 60],
  d: [240, 160, 100, 60],
};

const CONTAINER_RECT: [number, number, number, number] = [100, 50, 400, 300];

let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;

function stepFrame(times = 1) {
  for (let index = 0; index < times; index += 1) {
    const callbacks = [...frames.values()];
    frames.clear();
    act(() => {
      callbacks.forEach((callback) => callback(performance.now()));
    });
  }
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

function setup(
  options: {
    baseSelection?: string[];
    scrollLeft?: number;
    scrollTop?: number;
    scrollHeight?: number;
    clientHeight?: number;
  } = {},
) {
  const apiRef: { current: HarnessApi | null } = { current: null };
  const onChange = vi.fn<ChangeHandler>();
  const onCancel = vi.fn();
  const getBaseSelection = vi.fn(() => options.baseSelection ?? []);
  const view = render(
    <Harness
      apiRef={apiRef}
      onChange={onChange}
      onCancel={onCancel}
      getBaseSelection={getBaseSelection}
    />,
  );
  const container = screen.getByTestId("container");

  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    domRect(...CONTAINER_RECT),
  );
  for (const [id, bounds] of Object.entries(ITEM_RECTS)) {
    vi.spyOn(screen.getByTestId(`item-${id}`), "getBoundingClientRect").mockReturnValue(
      domRect(...bounds),
    );
  }
  Object.defineProperty(container, "scrollHeight", {
    configurable: true,
    value: options.scrollHeight ?? 600,
  });
  Object.defineProperty(container, "clientHeight", {
    configurable: true,
    value: options.clientHeight ?? 300,
  });
  container.scrollLeft = options.scrollLeft ?? 10;
  container.scrollTop = options.scrollTop ?? 20;

  return { ...view, apiRef, onChange, onCancel, getBaseSelection, container };
}

function pointerDown(
  target: Element,
  init: Record<string, unknown> = {},
) {
  fireEvent.pointerDown(target, {
    button: 0,
    buttons: 1,
    pointerId: 1,
    clientX: 110,
    clientY: 100,
    ...init,
  });
}

function pointerMove(init: Record<string, unknown>) {
  fireEvent.pointerMove(document, {
    pointerId: 1,
    buttons: 1,
    ...init,
  });
}

function pointerUp(init: Record<string, unknown> = {}) {
  fireEvent.pointerUp(document, {
    button: 0,
    pointerId: 1,
    ...init,
  });
}

function lastCall(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls[mock.mock.calls.length - 1];
}

beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  setVisibility("visible");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setVisibility("visible");
  document.body.innerHTML = "";
});

describe("useShelfMarquee", () => {
  it("空白处起拖，单行框选在 rAF 后才发布 move", () => {
    const { apiRef, onChange, container } = setup();

    pointerDown(container);
    pointerMove({ clientX: 112, clientY: 101 });
    expect(apiRef.current?.active).toBe(false);
    expect(screen.queryByTestId("overlay")).toBeNull();

    pointerMove({ clientX: 200, clientY: 130 });
    expect(apiRef.current?.active).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    // 达到阈值即可显示 overlay，但选择结果仍只在 rAF 中发布。
    let overlay = screen.getByTestId("overlay");
    expect(overlay.getAttribute("data-left")).toBe("20");
    expect(overlay.getAttribute("data-top")).toBe("70");
    expect(overlay.getAttribute("data-width")).toBe("90");
    expect(overlay.getAttribute("data-height")).toBe("30");
    // 未靠近边缘时不自动滚动。
    expect(container.scrollTop).toBe(20);

    stepFrame();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastCall(onChange)).toEqual([["a"], "replace", "move"]);
    overlay = screen.getByTestId("overlay");
    expect(overlay.getAttribute("data-left")).toBe("20");
    expect(overlay.getAttribute("data-top")).toBe("70");
    expect(overlay.getAttribute("data-width")).toBe("90");
    expect(overlay.getAttribute("data-height")).toBe("30");

    pointerUp({ clientX: 200, clientY: 130 });
    expect(lastCall(onChange)).toEqual([["a"], "replace", "end"]);
    expect(apiRef.current?.active).toBe(false);
    expect(apiRef.current?.rect).toBeNull();
    expect(screen.queryByTestId("overlay")).toBeNull();
  });

  it("多行框选命中相交条目，Shift 仍为 replace", () => {
    const { onChange, container } = setup();

    pointerDown(container, { shiftKey: true });
    pointerMove({ clientX: 350, clientY: 230 });
    stepFrame();

    expect(lastCall(onChange)).toEqual([
      ["a", "b", "c", "d"],
      "replace",
      "move",
    ]);
    const overlay = screen.getByTestId("overlay");
    expect(overlay.getAttribute("data-left")).toBe("20");
    expect(overlay.getAttribute("data-top")).toBe("70");
    expect(overlay.getAttribute("data-width")).toBe("240");
    expect(overlay.getAttribute("data-height")).toBe("130");
  });

  it("从右下往左上拖动，overlay 归一化为正宽高", () => {
    const { onChange, container } = setup();

    pointerDown(container, { clientX: 350, clientY: 230 });
    pointerMove({ clientX: 110, clientY: 100 });
    stepFrame();

    expect(lastCall(onChange)).toEqual([
      ["a", "b", "c", "d"],
      "replace",
      "move",
    ]);
    const overlay = screen.getByTestId("overlay");
    expect(overlay.getAttribute("data-left")).toBe("20");
    expect(overlay.getAttribute("data-top")).toBe("70");
    expect(overlay.getAttribute("data-width")).toBe("240");
    expect(overlay.getAttribute("data-height")).toBe("130");
  });

  it("Ctrl 框选与手势开始时的基准选择做 XOR", () => {
    let base = ["b", "z"];
    const { onChange, getBaseSelection, container } = setup();
    getBaseSelection.mockImplementation(() => base);

    pointerDown(container, { ctrlKey: true });
    // 手势开始后基准变化不影响本次手势（快照一次）。
    base = ["x"];
    pointerMove({ clientX: 350, clientY: 230 });
    stepFrame();

    expect(getBaseSelection).toHaveBeenCalledTimes(1);
    expect(lastCall(onChange)).toEqual([
      ["z", "a", "c", "d"],
      "toggle",
      "move",
    ]);

    pointerUp({ clientX: 350, clientY: 230 });
    expect(lastCall(onChange)).toEqual([
      ["z", "a", "c", "d"],
      "toggle",
      "end",
    ]);
  });

  it("条目、嵌套文本、按钮与 data-no-drag 上按下都不启动", () => {
    const { apiRef, onChange, container } = setup();
    const attempts: Element[] = [
      screen.getByTestId("item-a"),
      screen.getByTestId("item-a-label"),
      screen.getByTestId("action"),
      screen.getByTestId("no-drag"),
    ];

    for (const target of attempts) {
      pointerDown(target);
      pointerMove({ clientX: 350, clientY: 230 });
      stepFrame(2);
      expect(apiRef.current?.active).toBe(false);
      expect(screen.queryByTestId("overlay")).toBeNull();
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(20);
  });

  it("Alt+左键不启动框选", () => {
    const { apiRef, onChange, container } = setup();

    pointerDown(container, { altKey: true });
    pointerMove({ clientX: 350, clientY: 230 });
    stepFrame();

    expect(apiRef.current?.active).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("位移不超过 4px 不进入框选，松手也不产生 end", () => {
    const { apiRef, onChange, container } = setup();

    pointerDown(container);
    pointerMove({ clientX: 114, clientY: 100 });
    stepFrame();
    expect(apiRef.current?.active).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    pointerUp({ clientX: 114, clientY: 100 });
    expect(onChange).not.toHaveBeenCalled();
    expect(apiRef.current?.shouldSuppressClick()).toBe(false);
  });

  it("Esc 取消：通知 onCancel、不提交 end，并释放监听", () => {
    const { apiRef, onChange, onCancel, container } = setup();

    pointerDown(container);
    pointerMove({ clientX: 200, clientY: 130 });
    stepFrame();
    expect(onChange).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls.some((call) => call[2] === "end")).toBe(false);
    expect(apiRef.current?.active).toBe(false);
    expect(apiRef.current?.rect).toBeNull();

    pointerUp({ clientX: 200, clientY: 130 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("window blur 走取消路径，不提交 end", () => {
    const { onChange, onCancel, container } = setup();

    pointerDown(container);
    pointerMove({ clientX: 200, clientY: 130 });
    stepFrame();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls.some((call) => call[2] === "end")).toBe(false);
  });

  it("页面隐藏（visibilitychange=hidden）走取消路径", () => {
    const { onChange, onCancel, container } = setup();

    pointerDown(container);
    pointerMove({ clientX: 200, clientY: 130 });
    stepFrame();
    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls.some((call) => call[2] === "end")).toBe(false);
  });

  it("卸载后监听与 rAF 均释放，迟到的 pointermove 不再回调", () => {
    const { onChange, unmount, container } = setup();

    pointerDown(container);
    pointerMove({ clientX: 200, clientY: 130 });
    stepFrame();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);

    unmount();
    pointerMove({ clientX: 350, clientY: 230 });
    stepFrame(2);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("靠近底部边缘时每帧滚动 18px，并持续重算 move", () => {
    const { onChange, container } = setup({
      scrollLeft: 0,
      scrollTop: 0,
      scrollHeight: 600,
      clientHeight: 300,
    });

    pointerDown(container);
    pointerMove({ clientX: 200, clientY: 340 });
    stepFrame();
    expect(container.scrollTop).toBe(18);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastCall(onChange)[2]).toBe("move");
    // 仍停留在边缘区域：已排下一帧继续滚动。
    expect(frames.size).toBe(1);

    stepFrame();
    expect(container.scrollTop).toBe(36);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("容器没有内容溢出时不自动滚动", () => {
    const { onChange, container } = setup({
      scrollLeft: 0,
      scrollTop: 0,
      scrollHeight: 300,
      clientHeight: 300,
    });

    pointerDown(container);
    pointerMove({ clientX: 200, clientY: 340 });
    stepFrame();

    expect(container.scrollTop).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it("结束后的 350ms 内 shouldSuppressClick 为 true，之后自动失效", () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { apiRef, onChange, container } = setup();

    pointerDown(container);
    pointerMove({ clientX: 200, clientY: 130 });
    stepFrame();
    pointerUp({ clientX: 200, clientY: 130 });
    expect(lastCall(onChange)[2]).toBe("end");

    expect(apiRef.current?.shouldSuppressClick()).toBe(true);
    now = 1_349;
    expect(apiRef.current?.shouldSuppressClick()).toBe(true);
    now = 1_350;
    expect(apiRef.current?.shouldSuppressClick()).toBe(false);
  });
});
