/**
 * @vitest-environment jsdom
 *
 * FileList 矩形框选组件级回归：真实 React pointer 事件链 + 原生 window 监听 +
 * rAF 合并 + Escape/PointerCancel 清理。几何只构造在测试里，不依赖浏览器布局。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));

import FileList, { type FileListProps } from "./FileList";
import type { FsEntry } from "../../lib/bridge";

const DIR = "D:\\marquee-ui";

const entries: FsEntry[] = Array.from({ length: 40 }, (_, index) => ({
  name: `file-${String(index).padStart(3, "0")}.txt`,
  kind: "file" as const,
  ext: "txt",
  size: index,
  modifiedMs: 1,
  hidden: false,
  category: "text" as const,
}));

function baseProps(overrides: Partial<FileListProps> = {}): FileListProps {
  return {
    entries,
    dirPath: DIR,
    viewMode: "list",
    sessionKey: "tab-marquee",
    selectedPaths: new Set(),
    activePath: null,
    dropTargetPath: null,
    thumbnails: false,
    onEntryPointerDown: vi.fn(),
    onEntryActivate: vi.fn(),
    onEntryContextMenu: vi.fn(),
    onBodyPointerDown: vi.fn(),
    onBodyContextMenu: vi.fn(),
    onMarqueeChange: vi.fn(),
    onBlankClick: vi.fn(),
    ...overrides,
  };
}

function stubBody(container: HTMLElement, width = 600, height = 360): HTMLElement {
  const body = container.querySelector<HTMLElement>(".fw-body")!;
  Object.defineProperty(body, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(body, "clientHeight", { value: height, configurable: true });
  Object.defineProperty(body, "scrollHeight", { value: 40 * 26, configurable: true });
  body.scrollTop = 0;
  body.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return body;
}

async function drag(
  body: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  fireEvent.pointerDown(body, { button: 0, clientX: from.x, clientY: from.y, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y, pointerId: 1 });
  await waitFor(() => expect(document.querySelector(".fw-marquee")).toBeTruthy());
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FileList 矩形框选", () => {
  it("空白区越阈值后显示矩形并按虚拟行命中，松开提交", async () => {
    const onMarqueeChange = vi.fn();
    const { container } = render(<FileList {...baseProps({ onMarqueeChange })} />);
    const body = stubBody(container);

    await drag(body, { x: 10, y: 56 }, { x: 300, y: 66 });
    await waitFor(() => {
      expect(onMarqueeChange).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "preview",
          paths: [`${DIR}\\file-001.txt`],
          ctrlKey: false,
          shiftKey: false,
        }),
      );
    });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 66, pointerId: 1 });
    await waitFor(() => {
      expect(onMarqueeChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "commit", paths: [`${DIR}\\file-001.txt`] }),
      );
    });
    expect(document.querySelector(".fw-marquee")).toBeNull();
  });

  it("未超过 5px 阈值的空白点击不进入框选，只清空选择", async () => {
    const onMarqueeChange = vi.fn();
    const onBlankClick = vi.fn();
    const { container } = render(
      <FileList {...baseProps({ onMarqueeChange, onBlankClick })} />,
    );
    const body = stubBody(container);
    fireEvent.pointerDown(body, { button: 0, clientX: 10, clientY: 30, pointerId: 2 });
    fireEvent.pointerMove(window, { clientX: 13, clientY: 31, pointerId: 2 });
    fireEvent.pointerUp(window, { clientX: 13, clientY: 31, pointerId: 2 });
    await waitFor(() => expect(onBlankClick).toHaveBeenCalledTimes(1));
    expect(onMarqueeChange).not.toHaveBeenCalled();
    expect(document.querySelector(".fw-marquee")).toBeNull();
  });

  it("Escape 取消并恢复，不向面板冒泡；PointerCancel 同样清理", async () => {
    const onMarqueeChange = vi.fn();
    const { container } = render(<FileList {...baseProps({ onMarqueeChange })} />);
    const body = stubBody(container);
    await drag(body, { x: 10, y: 30 }, { x: 300, y: 40 });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(onMarqueeChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "cancel" }),
      );
    });
    expect(document.querySelector(".fw-marquee")).toBeNull();

    // 第二轮：PointerCancel 也必须清理矩形与候选
    fireEvent.pointerDown(body, { button: 0, clientX: 10, clientY: 60, pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 80, pointerId: 3 });
    await waitFor(() => expect(document.querySelector(".fw-marquee")).toBeTruthy());
    fireEvent.pointerCancel(window, { pointerId: 3 });
    await waitFor(() => expect(document.querySelector(".fw-marquee")).toBeNull());
    expect(onMarqueeChange).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "cancel" }));
  });

  it("在文件行/表头/按钮上按下不启动框选（文件拖拽与工具栏互斥）", async () => {
    const onMarqueeChange = vi.fn();
    const { container } = render(<FileList {...baseProps({ onMarqueeChange })} />);
    const body = stubBody(container);
    const row = container.querySelector("[data-fw-path]")!;
    fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 100, pointerId: 1 });
    expect(onMarqueeChange).not.toHaveBeenCalled();
    expect(document.querySelector(".fw-marquee")).toBeNull();

    const head = container.querySelector(".fw-list-head")!;
    fireEvent.pointerDown(head, { button: 0, clientX: 100, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 100, pointerId: 1 });
    expect(onMarqueeChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(body.querySelector(".fw-marquee")).toBeNull();
  });

  it("自动滚动只有一个循环，到边缘持续滚动但不超上限", async () => {
    const onMarqueeChange = vi.fn();
    const { container } = render(<FileList {...baseProps({ onMarqueeChange })} />);
    const body = stubBody(container);
    Object.defineProperty(body, "scrollHeight", { value: 40 * 26, configurable: true });
    await drag(body, { x: 10, y: 300 }, { x: 300, y: 355 });
    await waitFor(() => expect(body.scrollTop).toBeGreaterThan(0));
    // 松开后循环停止，不再继续滚动。
    fireEvent.pointerUp(window, { clientX: 300, clientY: 355, pointerId: 1 });
    await waitFor(() => expect(document.querySelector(".fw-marquee")).toBeNull());
    const stopped = body.scrollTop;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(body.scrollTop).toBe(stopped);
  });

  it("网格视图按列几何框选，换列数后候选不同", async () => {
    const onMarqueeChange = vi.fn();
    const onGridColsChange = vi.fn();
    const { container, rerender } = render(
      <FileList {...baseProps({ viewMode: "grid", onMarqueeChange, onGridColsChange })} />,
    );
    const body = stubBody(container, 720, 360);
    // 首次 effect 在 jsdom 矩形未桩化时按兜底列数运行；桩化后换一个回调身份触发
    // 一次真实测量，模拟原生 ResizeObserver 在容器宽度确定后重算列数。
    rerender(
      <FileList
        {...baseProps({ viewMode: "grid", onMarqueeChange, onGridColsChange: vi.fn() })}
      />,
    );
    await drag(body, { x: 4 + 112 + 2, y: 2 * 124 + 2 }, { x: 4 + 112 + 100, y: 2 * 124 + 80 });
    await waitFor(() => {
      expect(onMarqueeChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "preview", paths: [`${DIR}\\file-013.txt`] }),
      );
    });
    fireEvent.pointerUp(window, { pointerId: 1 });
    await waitFor(() => expect(document.querySelector(".fw-marquee")).toBeNull());

    Object.defineProperty(body, "clientWidth", { value: 480, configurable: true });
    rerender(
      <FileList
        {...baseProps({ viewMode: "grid", onMarqueeChange, onGridColsChange: vi.fn() })}
      />,
    );
    await drag(body, { x: 4 + 112 + 2, y: 2 * 124 + 2 }, { x: 4 + 112 + 100, y: 2 * 124 + 80 });
    await waitFor(() => {
      expect(onMarqueeChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "preview", paths: [`${DIR}\\file-009.txt`] }),
      );
    });
  });
});

describe("行视觉与状态通道（CSS 契约 + active/selected 分离）", () => {
  const css = readFileSync("src/components/files/files.css", "utf8");

  function rule(selector: string): string {
    const start = css.indexOf(selector);
    expect(start).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  }

  it("行槽不增加外边距，交互背景用 inset ::before 绘制", () => {
    const row = rule(".fw-row {");
    expect(row).toContain("position: relative");
    expect(row).not.toContain("margin");
    const skin = rule(".fw-row::before");
    expect(skin).toContain("inset: 1px 2px");
    expect(skin).toContain("border-radius: 4px");
    expect(skin).toContain("pointer-events: none");
    expect(skin).not.toContain("box-shadow");
  });

  it("连续选中保留独立轮廓，选中/焦点/投递使用不同通道", () => {
    const skin = rule(".fw-row::before");
    expect(skin).toContain("border-radius: 4px");
    const selected = rule(".fw-row.is-selected::before");
    expect(selected).toContain("border-color");
    expect(selected).not.toContain("border-radius: 0");
    const active = rule(".fw-row.is-active::before");
    expect(active).toContain("outline");
    const drop = rule(".fw-row.is-drop-folder::before");
    expect(drop).toContain("dashed");
    expect(drop).toContain("outline");
  });

  it("active 与 selected 可同时独立存在：未选中行也能渲染焦点类", () => {
    const { container } = render(
      <FileList {...baseProps({ selectedPaths: new Set(), activePath: `${DIR}\\file-001.txt` })} />,
    );
    const activeRow = Array.from(container.querySelectorAll("[data-fw-path]")).find(
      (node) => node.getAttribute("data-fw-path") === `${DIR}\\file-001.txt`,
    );
    expect(activeRow).toBeTruthy();
    expect(activeRow?.className).toContain("is-active");
    expect(activeRow?.className).not.toContain("is-selected");
    expect(activeRow?.getAttribute("aria-selected")).toBe("false");
  });
});
