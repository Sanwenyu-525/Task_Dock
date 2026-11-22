/**
 * @vitest-environment jsdom
 *
 * A04 文件工作区：列表响应式布局定向验证（第六轮补强）。
 * - 列表视图渲染吸顶表头（名称/修改时间/大小/类型），网格视图不渲染表头；
 * - 表头与文件行**共用**同一套 Grid 列定义，禁止各行自定列宽；
 * - 560/440/360 三个容器断点逐级隐藏次要列、缩短时间列，文件名列不归零；
 * - 超长文件名不撑破行，title 属性保留全名；
 * - 虚拟化只渲染窗口内行；表头高度与滚动偏移常量一致，不遮挡首行；
 * - 目录重挂载（布局预设切换/分栏重排）后按锚点文件恢复上次滚动位置。
 */

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";

afterEach(() => {
  cleanup();
  useFilesWorkspaceStore.setState({ colWidths: {} });
});

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: (key: string) => key,
  }),
}));

import FileList, { type FileListProps } from "./FileList";
import type { FsEntry } from "../../lib/bridge";

const css = readFileSync("src/components/files/files.css", "utf8");

const entry = (name: string, index: number): FsEntry => ({
  name,
  kind: "file",
  ext: "txt",
  size: 100 + index,
  modifiedMs: 1,
  hidden: false,
  category: "text",
});

const baseProps: Omit<FileListProps, "entries" | "dirPath" | "viewMode"> = {
  selectedPaths: new Set(),
  activePath: null,
  dropTargetPath: null,
  thumbnails: false,
  onEntryPointerDown: vi.fn(),
  onEntryActivate: vi.fn(),
  onEntryContextMenu: vi.fn(),
  onBodyPointerDown: vi.fn(),
  onBodyContextMenu: vi.fn(),
};

const many = Array.from({ length: 60 }, (_, i) => entry(`file-${String(i).padStart(3, "0")}.txt`, i));

describe("FileList 列表表头", () => {
  it("列表视图渲染与列对齐的吸顶表头，网格视图不渲染表头", () => {
    const { rerender, container } = render(
      <FileList {...baseProps} entries={many} dirPath="D:\\a-list" viewMode="list" />,
    );

    const head = container.querySelector(".fw-list-head");
    expect(head).toBeTruthy();
    // 表头列名不带「按」字（排序菜单的 fw.sort.* 保留给排序入口；列名暂走代码内双语映射）。
    expect(head?.querySelector(".fw-row-name")?.textContent).toBe("名称");
    expect(head?.querySelector(".fw-row-time")?.textContent).toBe("修改日期");
    expect(head?.querySelector(".fw-row-size")?.textContent).toBe("大小");
    expect(head?.querySelector(".fw-row-type")?.textContent).toBe("类型");

    rerender(<FileList {...baseProps} entries={many} dirPath="D:\\a-list" viewMode="grid" />);
    expect(container.querySelector(".fw-list-head")).toBeNull();
  });

  it("超长文件名不撑破行，title 属性保留完整文件名", () => {
    const longName = "a-very-long-contiguous-filename-without-spaces-" + "x".repeat(60) + ".txt";
    render(
      <FileList
        {...baseProps}
        entries={[entry(longName, 0)]}
        dirPath="D:\\a-long-name"
        viewMode="list"
      />,
    );
    const rowName = screen.getByTitle(longName);
    expect(rowName.className).toContain("fw-row-name");
    expect(rowName.textContent).toBe(longName);
  });
});

describe("表头与文件行共用列定义", () => {
  /** 取某个选择器规则块（允许前后空白与逗号分隔的选择器）。 */
  function ruleBlock(selectorPattern: RegExp): string | null {
    const match = selectorPattern.exec(css);
    if (!match) return null;
    return ruleBlockAt(match.index);
  }

  function ruleBlockAt(index: number): string {
    const start = css.indexOf("{", index);
    const end = css.indexOf("}", start);
    return css.slice(start + 1, end);
  }

  /** 取完整的 @container 规则块（按花括号层级配对，避免嵌套规则截断）。 */
  function containerBlock(header: string): string {
    const start = css.indexOf(header);
    expect(start).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) return css.slice(open + 1, i);
      }
    }
    throw new Error(`unclosed container block: ${header}`);
  }

  it("共享规则同时声明 .fw-row 与 .fw-list-head，且 grid-template-columns 只出现一次", () => {
    expect(css).toMatch(/\.fw-row,\s*\.fw-list-head\s*\{/);
    const shared = ruleBlock(/\.fw-row,\s*\.fw-list-head\s*\{/);
    expect(shared).toBeTruthy();
    expect(shared).toContain("display: grid");
    expect(shared).toContain("grid-template-columns");
    expect(shared).toContain("var(--fw-col-name)");
    expect(shared).toContain("var(--fw-col-time)");
    expect(shared).toContain("var(--fw-col-size)");
    expect(shared).toContain("var(--fw-col-type)");

    const rowOnly = ruleBlock(/\.fw-row\s*\{/);
    expect(rowOnly).not.toContain("grid-template-columns");
  });

  it("表头 sticky 且高度为 26px（与滚动范围换算的 headOffset 一致）", () => {
    // 共享列定义里 `.fw-list-head` 也位于行首；用 sticky 声明唯一定位表头规则块。
    const match = /\.fw-list-head\s*\{\s*position:\s*sticky/.exec(css);
    expect(match).toBeTruthy();
    const head = ruleBlockAt(match!.index);
    expect(head).toContain("position: sticky");
    expect(head).toContain("top: 0");
    expect(head).toContain("height: 26px");
  });

  it("560px 断点隐藏类型列；440px 隐藏大小列；360px 缩短时间列并保留文件名", () => {
    const b560 = containerBlock("@container (max-width: 560px)");
    expect(b560).toContain(".fw-row-type");
    expect(b560).toContain(".fw-list-head .fw-row-type");

    const b440 = containerBlock("@container (max-width: 440px)");
    expect(b440).toContain(".fw-row-size");
    expect(b440).toContain(".fw-list-head .fw-row-size");
    expect(b440).toContain("var(--fw-col-name)");

    const b360 = containerBlock("@container (max-width: 360px)");
    expect(b360).toContain(".fw-row,");
    expect(b360).toContain(".fw-list-head");
    expect(b360).toContain("--fw-col-time: 96px");
    expect(b360).toContain("font-size: 10.5px");
  });

  it("表头渲染在滚动容器内、首行之前；表头不参与绝对定位偏移", () => {
    const { container } = render(
      <FileList {...baseProps} entries={many} dirPath="D:\\a-head" viewMode="list" />,
    );
    const body = container.querySelector<HTMLElement>(".fw-body")!;
    const head = body.querySelector<HTMLElement>(".fw-list-head")!;
    // 表头是滚动容器第一个子元素；虚拟化内层紧随其后（无独立 class，用兄弟关系定位）。
    const inner = head.nextElementSibling as HTMLElement | null;
    expect(head).toBeTruthy();
    expect(inner).toBeTruthy();
    expect(head.compareDocumentPosition(inner!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(body.firstElementChild).toBe(head);
    // 内层高度 = 行数 × 行高；表头占普通流高度，不叠加到行绝对定位。
    expect(inner!.style.height).not.toBe("");
  });

  it("虚拟化只渲染窗口内行，不把 60 个条目全部挂载", () => {
    const { container } = render(
      <FileList {...baseProps} entries={many} dirPath="D:\\a-virtual" viewMode="list" />,
    );
    const rows = container.querySelectorAll(".fw-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(many.length);
  });

  it("日期/大小列左对齐：数据行不再右对齐（与表头同起点）", () => {
    const time = ruleBlock(/\.fw-row-time\s*\{/);
    const size = ruleBlock(/\.fw-row-size\s*\{/);
    expect(time).not.toContain("justify-self: end");
    expect(time).not.toContain("text-align: right");
    expect(size).not.toContain("justify-self: end");
    expect(size).not.toContain("text-align: right");
  });

  it("表头列显式锚定轨道；拖拽手柄贴列左缘；窄栏断点隐藏对应手柄", () => {
    // 名称表头跨「图标+名称」两轨与文件行图标左缘对齐；其余列锚定各自轨道。
    const nameAnchor = ruleBlock(/\.fw-list-head \.fw-row-name\s*\{ grid-column: 1 \/ 3; grid-row: 1;/);
    expect(nameAnchor).toBeTruthy();
    for (const [cls, track] of [
      [".fw-row-time", 3],
      [".fw-row-size", 4],
      [".fw-row-type", 5],
    ] as const) {
      expect(ruleBlock(new RegExp(`\\.fw-list-head \\${cls}\\s*\\{ grid-column: ${track};`))).toBeTruthy();
    }
    const handle = ruleBlock(/\.fw-col-handle\s*\{/);
    expect(handle).toContain("cursor: col-resize");
    // 边界语义：手柄贴列左缘（分隔线=两列边界，随光标移动、两侧列互补）。
    expect(handle).toContain("justify-self: start");
    expect(handle).toContain("margin-left: -6px");
    // 分隔线静止可见（加强色），悬停/拖拽/聚焦变强调色。
    expect(ruleBlock(/\.fw-col-handle::after\s*\{/)).toContain("var(--border-strong)");
    expect(ruleBlock(/\.fw-col-handle--time\s*\{/)).toContain("grid-column: 3");
    expect(ruleBlock(/\.fw-col-handle--size\s*\{/)).toContain("grid-column: 4");
    expect(ruleBlock(/\.fw-col-handle--type\s*\{/)).toContain("grid-column: 5");

    const b560 = containerBlock("@container (max-width: 560px)");
    expect(b560).toContain(".fw-col-handle--type");
    const b440 = containerBlock("@container (max-width: 440px)");
    expect(b440).toContain(".fw-col-handle--size");
  });
});

describe("表头列宽拖拽手柄（边界语义）", () => {
  const renderList = () =>
    render(<FileList {...baseProps} entries={many} dirPath="D:\a-handle" viewMode="list" />);

  it("列表视图渲染 3 个边界手柄（name-time/time-size/size-type），网格视图不渲染；手柄暴露 aria", () => {
    const { container, rerender } = renderList();
    const handles = container.querySelectorAll(".fw-col-handle");
    expect(handles.length).toBe(3);
    const timeHandle = container.querySelector<HTMLElement>(".fw-col-handle--time")!;
    expect(timeHandle.getAttribute("role")).toBe("separator");
    expect(timeHandle.getAttribute("aria-orientation")).toBe("vertical");
    // 边界手柄文案描述两侧列（名称/修改日期）。
    expect(timeHandle.getAttribute("aria-label")).toBe("调整名称与修改日期列宽");
    expect(timeHandle.getAttribute("tabindex")).toBe("0");
    expect(timeHandle.getAttribute("data-tip")).toContain("双击");

    rerender(<FileList {...baseProps} entries={many} dirPath="D:\a-handle" viewMode="grid" />);
    expect(container.querySelectorAll(".fw-col-handle").length).toBe(0);
  });

  it("store 列宽以内联 CSS 变量注入（仅定制列，未定制走 CSS 默认）", () => {
    act(() => useFilesWorkspaceStore.setState({ colWidths: { time: 200 } }));
    const { container } = renderList();
    const body = container.querySelector<HTMLElement>(".fw-body")!;
    expect(body.style.getPropertyValue("--fw-col-time")).toBe("200px");
    expect(body.style.getPropertyValue("--fw-col-size")).toBe("");
  });

  it("双击边界手柄恢复两侧列默认；键盘 ←/→ 沿边界互补调宽", () => {
    useFilesWorkspaceStore.setState({ colWidths: { time: 200, size: 120 } });
    const { container } = renderList();
    fireEvent.doubleClick(container.querySelector<HTMLElement>(".fw-col-handle--time")!);
    // name-time 边界只复位日期列；time-size 边界复位日期+大小两列。
    expect(useFilesWorkspaceStore.getState().colWidths).toEqual({ size: 120 });
    fireEvent.doubleClick(container.querySelector<HTMLElement>(".fw-col-handle--size")!);
    expect(useFilesWorkspaceStore.getState().colWidths).toEqual({});

    const sizeHandle = container.querySelector<HTMLElement>(".fw-col-handle--size")!;
    fireEvent.keyDown(sizeHandle, { key: "ArrowRight" });
    // 边界互补：time +8 / size -8（time-size 边界只受两列上下限钳制）。
    expect(useFilesWorkspaceStore.getState().colWidths).toEqual({ time: 126, size: 68 });
    expect(sizeHandle.getAttribute("aria-label")).toBe("调整修改日期与大小列宽");

    // name-time 边界：jsdom 容器宽 0 → 名称保底（96）不可能满足，位移被钳到
    // hi（日期列自身下限 72），分隔线停在钳制点（与 Windows 一致）。
    fireEvent.keyDown(container.querySelector<HTMLElement>(".fw-col-handle--time")!, { key: "ArrowRight" });
    expect(useFilesWorkspaceStore.getState().colWidths).toEqual({ time: 72, size: 68 });
  });
});
