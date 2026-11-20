/**
 * @vitest-environment jsdom
 *
 * A06 文件工作区：分栏分割线键盘/指针回归（第六轮）。
 * 断言不只看截图：每条操作后同时核对
 *   1) store 树比例；2) 分隔线 aria-valuemin/max/now；3) 第一子区域内联宽度表达式。
 * 第二子区域按 CSS `flex: 1 1 auto` 占满余量（无内联宽度）。
 * ARIA 边界必须来自与拖拽相同的 `minPx/容器尺寸` 换算，不能固定 15/85。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));

// FilePane 懒加载：分割线测试只验证树比例与分隔线行为，不拉起真实目录列表。
vi.mock("./FilePane", () => ({
  default: () => <div data-testid="stub-pane" />,
}));

import { SplitWithDivider } from "./FilesWorkspacePanel";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import type { SplitNode } from "../../lib/filesWorkspace/model";

const SPLIT_ID = "split-1";
const MIN_PANE_W = 220;

function makeTree(ratio: number): SplitNode {
  return {
    type: "split",
    id: SPLIT_ID,
    direction: "horizontal",
    ratio,
    first: { type: "pane", paneId: "pane-a" },
    second: { type: "pane", paneId: "pane-b" },
  };
}

function hydrate(ratio: number): void {
  useFilesWorkspaceStore.getState().hydrate(
    {
      tree: makeTree(ratio),
      panes: [
        { paneId: "pane-a", tabs: [{ tabId: "ta", path: "D:\\a" }], activeTabId: "ta" },
        { paneId: "pane-b", tabs: [{ tabId: "tb", path: "D:\\b" }], activeTabId: "tb" },
      ],
      activePaneId: "pane-a",
    },
    "global",
  );
}

function currentRatio(): number {
  const tree = useFilesWorkspaceStore.getState().tree;
  if (tree.type !== "split") throw new Error("expected split tree");
  return tree.ratio;
}

/** jsdom 矩形恒 0：给分割容器稳定区域，钳制边界按宽度换算。 */
let containerWidth = 800;

function stubContainerRect(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.className.includes("fw-split")) {
      return {
        left: 0,
        top: 0,
        right: containerWidth,
        bottom: 600,
        width: containerWidth,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

/** 捕获 ResizeObserver 回调，用于模拟窗口/分栏尺寸变化。 */
const resizeCallbacks: Array<() => void> = [];
class FakeResizeObserver {
  constructor(cb: () => void) {
    resizeCallbacks.push(cb);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const baseProps = {
  pageActive: true,
  maximizedPaneId: null,
  dropHintPane: null,
  dropHint: null,
  onHoverZone: vi.fn(),
  layoutEditMode: false,
  projectRoot: null,
};

function renderSplitter() {
  const tree = useFilesWorkspaceStore.getState().tree;
  const view = render(
    <SplitWithDivider node={tree as Extract<SplitNode, { type: "split" }>} {...baseProps} />,
  );
  // store 比例变更后用最新树重新挂载节点 prop，模拟面板层按 store tree 重渲染。
  const refresh = () => {
    const fresh = useFilesWorkspaceStore.getState().tree;
    view.rerender(
      <SplitWithDivider node={fresh as Extract<SplitNode, { type: "split" }>} {...baseProps} />,
    );
  };
  const divider = view.container.querySelector<HTMLElement>(".fw-divider");
  const children = view.container.querySelectorAll<HTMLElement>(".fw-split-child");
  expect(divider).toBeTruthy();
  expect(children.length).toBe(2);
  return { view, refresh, divider: divider!, first: children[0], second: children[1] };
}

/** 百分比：边界允许一位小数，避免 27.5% 被四舍五入成 28 而与实际布局分叉。 */
const pct = (ratio: number): string => String(Math.round(ratio * 1000) / 10);

/** 一致性断言：store 比例、aria min/max/now、第一侧内联宽度对齐。 */
function expectRatioConsistent(
  els: { divider: HTMLElement; first: HTMLElement; second: HTMLElement },
  expected: { ratio: number; min: number; max: number },
): void {
  const ratio = currentRatio();
  expect(ratio).toBeCloseTo(expected.ratio, 6);
  expect(els.divider.getAttribute("aria-valuenow")).toBe(pct(ratio));
  expect(els.divider.getAttribute("aria-valuemin")).toBe(pct(expected.min));
  expect(els.divider.getAttribute("aria-valuemax")).toBe(pct(expected.max));
  // 分隔条命中区 8px，首侧内联宽度按半宽 4px 扣除（视觉线条 1px 居中）。
  const widthMatch = /calc\(([\d.]+)% - 4px\)/.exec(els.first.style.width);
  expect(widthMatch).toBeTruthy();
  // jsdom 会对 calc() 中的百分比做约 4 位小数的序列化，按 3 位精度比较。
  expect(Number(widthMatch![1])).toBeCloseTo(ratio * 100, 3);
  expect(els.second.className).toContain("fw-split-child-second");
  expect(els.second.style.width).toBe("");
}

/** 800px 容器：minRatio=220/800=0.275，maxRatio=0.725。 */
const bounds800 = { min: MIN_PANE_W / 800, max: 1 - MIN_PANE_W / 800 };
/** 400px 容器：min(0.45, 220/400)=0.45。 */
const bounds400 = { min: 0.45, max: 0.55 };

beforeEach(() => {
  containerWidth = 800;
  stubContainerRect();
  hydrate(0.5);
  resizeCallbacks.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("分割线键盘调整", () => {
  it("ArrowRight 微调 +0.03，比例/aria/第一侧宽度一致", () => {
    const els = renderSplitter();
    fireEvent.keyDown(els.divider, { key: "ArrowRight" });
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.53, ...bounds800 });
  });

  it("ArrowLeft 微调 -0.03", () => {
    const els = renderSplitter();
    fireEvent.keyDown(els.divider, { key: "ArrowLeft" });
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.47, ...bounds800 });
  });

  it("Shift + ArrowRight 大步 +0.1", () => {
    const els = renderSplitter();
    fireEvent.keyDown(els.divider, { key: "ArrowRight", shiftKey: true });
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.6, ...bounds800 });
  });

  it("Home/End 到真实边界，aria min/max 与 store、布局一致", () => {
    const els = renderSplitter();
    fireEvent.keyDown(els.divider, { key: "Home" });
    els.refresh();
    expectRatioConsistent(els, { ratio: bounds800.min, ...bounds800 });

    fireEvent.keyDown(els.divider, { key: "End" });
    els.refresh();
    expectRatioConsistent(els, { ratio: bounds800.max, ...bounds800 });
  });

  it("Enter 复位为 50:50", () => {
    const els = renderSplitter();
    fireEvent.keyDown(els.divider, { key: "ArrowRight" });
    els.refresh();
    fireEvent.keyDown(els.divider, { key: "Enter" });
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.5, ...bounds800 });
  });

  it("撤销/重做布局后比例、aria 与宽度同步", () => {
    const els = renderSplitter();
    fireEvent.keyDown(els.divider, { key: "ArrowRight" });
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.53, ...bounds800 });

    act(() => useFilesWorkspaceStore.getState().undoLayout());
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.5, ...bounds800 });

    act(() => useFilesWorkspaceStore.getState().redoLayout());
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.53, ...bounds800 });
  });
});

describe("容器尺寸变化后的 ARIA 边界", () => {
  it("800px → 400px：min/max 重算，越界比例收敛到新边界并同步 Store/布局", () => {
    const els = renderSplitter();
    fireEvent.keyDown(els.divider, { key: "End", shiftKey: false });
    els.refresh();
    // 先到 800px 的右边界 72.5%，再缩到 400px（合法区间 45%–55%）。
    expectRatioConsistent(els, { ratio: bounds800.max, ...bounds800 });

    containerWidth = 400;
    act(() => resizeCallbacks.forEach((cb) => cb()));
    els.refresh();
    expectRatioConsistent(els, { ratio: bounds400.max, ...bounds400 });
  });

  it("400px 容器下 Home/End 仍与实际边界一致", () => {
    containerWidth = 400;
    const els = renderSplitter();
    fireEvent.keyDown(els.divider, { key: "Home" });
    els.refresh();
    expectRatioConsistent(els, { ratio: bounds400.min, ...bounds400 });

    fireEvent.keyDown(els.divider, { key: "End" });
    els.refresh();
    expectRatioConsistent(els, { ratio: bounds400.max, ...bounds400 });
  });
});

describe("分割线双击与右键比例菜单", () => {
  it("双击复位为 50:50，且仍只渲染 1px 线条（无把手药丸）", () => {
    const els = renderSplitter();
    expect(els.divider.querySelector(".fw-divider-grip")).toBeNull();
    expect(els.divider.querySelector(".fw-divider-line")).toBeTruthy();

    fireEvent.keyDown(els.divider, { key: "ArrowRight" });
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.53, ...bounds800 });

    fireEvent.doubleClick(els.divider);
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.5, ...bounds800 });
  });

  it("右键比例菜单选择 33:67 后比例/aria/宽度一致，菜单关闭", () => {
    const els = renderSplitter();
    fireEvent.contextMenu(els.divider, { clientX: 200, clientY: 200 });

    const menu = screen.getByRole("menu", { name: "fw.divider.ratioMenu" });
    expect(menu).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /33\s*:\s*67/ }));

    els.refresh();
    expectRatioConsistent(els, { ratio: 1 / 3, ...bounds800 });
    expect(screen.queryByRole("menu", { name: "fw.divider.ratioMenu" })).toBeNull();
  });

  it("右键比例菜单 Escape 关闭且不改比例", () => {
    const els = renderSplitter();
    fireEvent.contextMenu(els.divider, { clientX: 200, clientY: 200 });
    expect(screen.getByRole("menu", { name: "fw.divider.ratioMenu" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    els.refresh();
    expectRatioConsistent(els, { ratio: 0.5, ...bounds800 });
    expect(screen.queryByRole("menu", { name: "fw.divider.ratioMenu" })).toBeNull();
  });
});

describe("分割线指针事务取消", () => {
  it("指针拖动提交后 Store/ARIA/实际宽度一致", () => {
    const els = renderSplitter();
    fireEvent.pointerDown(els.divider, { button: 0, pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(els.divider, { pointerId: 1, clientX: 500 });
    fireEvent.pointerUp(els.divider, { pointerId: 1, clientX: 500 });
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.625, ...bounds800 });
  });

  it("Escape 取消拖动事务：比例回滚，退出调整态", () => {
    const els = renderSplitter();
    fireEvent.pointerDown(els.divider, { button: 0, pointerId: 1, clientX: 400 });
    expect(document.body.classList.contains("fw-resizing")).toBe(true);

    fireEvent.keyDown(els.divider, { key: "Escape" });
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.5, ...bounds800 });
    expect(document.body.classList.contains("fw-resizing")).toBe(false);
  });

  it("PointerCancel 回滚临时比例并退出调整态", () => {
    const els = renderSplitter();
    fireEvent.pointerDown(els.divider, { button: 0, pointerId: 2, clientX: 400 });
    expect(document.body.classList.contains("fw-resizing")).toBe(true);

    fireEvent.pointerCancel(els.divider, { pointerId: 2 });
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.5, ...bounds800 });
    expect(document.body.classList.contains("fw-resizing")).toBe(false);
  });

  it("LostPointerCapture 回滚临时比例并退出调整态", () => {
    const els = renderSplitter();
    fireEvent.pointerDown(els.divider, { button: 0, pointerId: 3, clientX: 400 });
    fireEvent.pointerMove(els.divider, { pointerId: 3, clientX: 470 });
    els.refresh();
    expect(currentRatio()).toBeCloseTo(0.5, 6);

    fireEvent.lostPointerCapture(els.divider, { pointerId: 3 });
    els.refresh();
    expectRatioConsistent(els, { ratio: 0.5, ...bounds800 });
    expect(document.body.classList.contains("fw-resizing")).toBe(false);
  });
});
