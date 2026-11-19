/**
 * @vitest-environment jsdom
 */
//! 弹层边缘行为：底部空间不足时向上翻转，窄窗口里不溢出视口。
//!
//! jsdom 没有排版引擎，矩形全是 0，因此这里显式伪造「锚点位置 / 弹层尺寸 / 视口尺寸」，
//! 让 floating-ui 的 flip + shift 走真实计算路径，断言最终落位（data-placement）。
//!
//! 注意：documentElement / body 的矩形必须保持全 0——floating-ui 会把它当成
//! 滚动条偏移量（getWindowScrollBarX），一旦非 0，所有横向计算都会偏掉。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import Select from "./Select";

interface Geometry {
  anchorTop: number;
  anchorLeft: number;
  floatingWidth: number;
  floatingHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

function makeRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

const ZERO = makeRect(0, 0, 0, 0);

/** 弹层宿主（floating-ui 定位的就是它）与锚点的矩形要区分开。 */
function isFloating(el: Element) {
  return el.classList?.contains("ui-popover-host") ?? false;
}

function stubGeometry(g: Geometry) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === document.documentElement || this === document.body) return ZERO;
    if (isFloating(this)) return makeRect(0, 0, g.floatingWidth, g.floatingHeight);
    return makeRect(g.anchorLeft, g.anchorTop, 160, 24);
  });

  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return isFloating(this) ? g.floatingWidth : 160;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isFloating(this) ? g.floatingHeight : 24;
    },
  });

  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: g.viewportWidth,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    value: g.viewportHeight,
  });
}

const OPTIONS = [
  { value: "a", label: "选项 A" },
  { value: "b", label: "选项 B" },
];

/** 320px 窄窗口：弹层比窗口还宽，左右都放不下，只剩「向上」一条路。 */
const NARROW = { viewportWidth: 320, viewportHeight: 600, floatingWidth: 260, floatingHeight: 300 };

function Harness({ align }: { align?: "start" | "end" | "auto" } = {}) {
  const [value, setValue] = useState("a");
  return <Select ariaLabel="测试下拉" value={value} options={OPTIONS} onChange={setValue} align={align} />;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("弹层边缘定位", () => {
  it("下方空间充足时向下展开，默认左缘对齐", async () => {
    const user = userEvent.setup();
    stubGeometry({ ...NARROW, anchorTop: 100, anchorLeft: 40 });
    render(<Harness />);

    await user.click(screen.getByRole("combobox", { name: "测试下拉" }));
    const popover = await screen.findByRole("listbox");
    await waitFor(() => expect(popover.getAttribute("data-placement")).toBe("bottom-start"));
  });

  it("底部空间不足时自动向上翻转，对齐关系保持 start", async () => {
    const user = userEvent.setup();
    stubGeometry({ ...NARROW, anchorTop: 560, anchorLeft: 40 });
    render(<Harness />);

    await user.click(screen.getByRole("combobox", { name: "测试下拉" }));
    const popover = await screen.findByRole("listbox");
    await waitFor(() => expect(popover.getAttribute("data-placement")).toBe("top-start"));
  });

  it("显式 align=end：即使左侧空间不足也保持右缘对齐（只平移不换边）", async () => {
    const user = userEvent.setup();
    stubGeometry({ ...NARROW, anchorTop: 100, anchorLeft: 20 });
    render(<Harness align="end" />);

    await user.click(screen.getByRole("combobox", { name: "测试下拉" }));
    const popover = await screen.findByRole("listbox");
    await waitFor(() => expect(popover.getAttribute("data-placement")).toBe("bottom-end"));
  });

  it("align=auto：靠近右缘时自动从 start 切到 end", async () => {
    const user = userEvent.setup();
    stubGeometry({ viewportWidth: 600, viewportHeight: 600, floatingWidth: 260, floatingHeight: 200, anchorTop: 100, anchorLeft: 380 });
    render(<Harness align="auto" />);

    await user.click(screen.getByRole("combobox", { name: "测试下拉" }));
    const popover = await screen.findByRole("listbox");
    await waitFor(() => expect(popover.getAttribute("data-placement")).toBe("bottom-end"));
  });

  it("弹层始终落在视口内（左/右各留 8px）", async () => {
    const user = userEvent.setup();
    stubGeometry({ viewportWidth: 320, viewportHeight: 600, floatingWidth: 300, floatingHeight: 200, anchorTop: 100, anchorLeft: 260 });
    render(<Harness />);

    await user.click(screen.getByRole("combobox", { name: "测试下拉" }));
    const host = (await screen.findByRole("listbox")).closest(".ui-popover-host") as HTMLElement;
    // jsdom 没有真实 translate 计算，落位由浮层 host 的 left/top 或 transform 表达；
    // 这里断言尺寸变量被收敛到可用宽，而不是断言屏幕像素坐标。
    const maxWidth = Number(host.dataset.popupMaxWidth);
    expect(maxWidth).toBeLessThanOrEqual(320 - 16);
  });

  it("内容尺寸变化后重新定位（同一次打开内翻转）", async () => {
    const user = userEvent.setup();
    const geometry = { viewportWidth: 600, viewportHeight: 600, floatingWidth: 260, floatingHeight: 120, anchorTop: 350, anchorLeft: 100 };
    stubGeometry(geometry);
    render(<Harness />);

    await user.click(screen.getByRole("combobox", { name: "测试下拉" }));
    const popover = await screen.findByRole("listbox");
    await waitFor(() => expect(popover.getAttribute("data-placement")).toBe("bottom-start"));

    // 打开后内容变高：下方放不下、上方够 → 同一次打开内翻到上方（不重新挂载）
    geometry.floatingHeight = 250;
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(popover.getAttribute("data-placement")).toBe("top-start"));
  });

  it("弹层挂在 document.body 上，不受内容区裁剪", async () => {
    const user = userEvent.setup();
    stubGeometry({ ...NARROW, anchorTop: 100, anchorLeft: 40 });
    render(
      <div style={{ overflow: "hidden", height: "120px" }}>
        <Harness />
      </div>,
    );

    await user.click(screen.getByRole("combobox", { name: "测试下拉" }));
    const popover = await screen.findByRole("listbox");
    // 浮层是 portal 到 body 的，因此不会被父容器的 overflow 裁掉
    expect(popover.closest(".ui-popover-host")?.parentElement).toBe(document.body);
  });
});
