/**
 * @vitest-environment jsdom
 *
 * R13 Agent B：列表表头与数据行的对齐契约。
 * 结论：表头与行共用 --fw-col-* 同一套 grid 轨道；**表头文字全部左对齐**，
 * 数据行的名称/类型左对齐、时间/大小右对齐；容器断点同步作用于两者。
 * jsdom 不计算像素，这里验证 DOM 结构与 CSS 声明契约，真实视觉待 B/C 通道。
 */

import { readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => cleanup());

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

/** 取某个行首选择器规则块的声明体。 */
function ruleBlock(selectorPattern: RegExp): string | null {
  const match = selectorPattern.exec(css);
  if (!match) return null;
  const start = css.indexOf("{", match.index);
  const end = css.indexOf("}", start);
  return css.slice(start + 1, end);
}

/** 取某个行首选择器规则块（含选择器与声明体）。 */
function ruleText(selectorPattern: RegExp): string | null {
  const match = selectorPattern.exec(css);
  if (!match) return null;
  const open = css.indexOf("{", match.index);
  const end = css.indexOf("}", open);
  return css.slice(match.index, end + 1);
}

/** 取完整的 @container 规则块（按花括号层级配对）。 */
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

const entry: FsEntry = {
  name: "report.txt",
  kind: "file",
  ext: "txt",
  size: 1024,
  modifiedMs: 1,
  hidden: false,
  category: "text",
};

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

describe("表头与行共用列定义（无需分别写百分比/固定 margin）", () => {
  it("共享 grid 规则同时覆盖 .fw-row 与 .fw-list-head", () => {
    expect(css).toMatch(/^\.fw-row,\s*\.fw-list-head\s*\{/m);
    const shared = ruleBlock(/^\.fw-row,\s*\.fw-list-head\s*\{/m);
    expect(shared).toContain("display: grid");
    expect(shared).toContain("grid-template-columns");
    for (const col of ["--fw-col-icon", "--fw-col-name", "--fw-col-time", "--fw-col-size", "--fw-col-type"]) {
      expect(shared).toContain(col);
    }
  });

  it("列宽变量只在一处 .fw-body.fw-list 定义", () => {
    expect(css).toMatch(/^\.fw-body\.fw-list\s*\{/m);
    const vars = ruleBlock(/^\.fw-body\.fw-list\s*\{/m);
    expect(vars).toContain("--fw-col-icon: 15px");
    expect(vars).toContain("--fw-col-name: minmax(0, 1fr)");
    expect(vars).toContain("--fw-col-time: 118px");
    expect(vars).toContain("--fw-col-size: 76px");
    expect(vars).toContain("--fw-col-type: 88px");
  });
});

describe("对齐方向：表头全部左对齐，数据行数值列仍右对齐", () => {
  it("表头四列（名称/时间/大小/类型）覆盖为左对齐", () => {
    expect(css).toMatch(/^\.fw-list-head \.fw-row-name,/m);
    const head = ruleText(/^\.fw-list-head \.fw-row-name,/m);
    expect(head).toBeTruthy();
    for (const cls of ["fw-row-name", "fw-row-time", "fw-row-size", "fw-row-type"]) {
      expect(head).toContain(`.fw-list-head .${cls}`);
    }
    expect(head).toContain("justify-self: start");
    expect(head).toContain("text-align: left");
    // 表头对齐只能是表头作用域，不得写回数据行。
    expect(head).not.toContain(".fw-row-time {");
  });

  it("数据行的时间列与大小列仍右对齐并右贴轨道末端", () => {
    for (const cls of ["fw-row-time", "fw-row-size"]) {
      const block = ruleBlock(new RegExp(`^\\.${cls}\\s*\\{`, "m"));
      expect(block, `missing .${cls} rule`).toBeTruthy();
      expect(block).toContain("justify-self: end");
      expect(block).toContain("text-align: right");
    }
  });

  it("名称列与类型列在数据行保持左对齐（省略号不影响起始位置）", () => {
    const name = ruleBlock(/^\.fw-row-name\s*\{/m);
    expect(name).toContain("overflow: hidden");
    expect(name).toContain("text-overflow: ellipsis");
    expect(name).not.toContain("justify-self: end");
    const type = ruleBlock(/^\.fw-row-type\s*\{/m);
    expect(type).toContain("text-overflow: ellipsis");
    expect(type).not.toContain("justify-self: end");
  });

  it("表头复用行单元格 class，且与数据行共享同一套列单元格", () => {
    const { container } = render(
      <FileList {...baseProps} entries={[entry]} dirPath="D:\\align" viewMode="list" />,
    );
    const head = container.querySelector<HTMLElement>(".fw-list-head")!;
    const row = container.querySelector<HTMLElement>(".fw-row")!;
    expect(head).toBeTruthy();
    expect(row).toBeTruthy();
    for (const cls of ["fw-row-icon", "fw-row-name", "fw-row-time", "fw-row-size", "fw-row-type"]) {
      expect(head.querySelector(`.${cls}`), `head missing .${cls}`).toBeTruthy();
      expect(row.querySelector(`.${cls}`), `row missing .${cls}`).toBeTruthy();
    }
  });
});

describe("窄栏断点：表头与行同步收敛，横向滚动同源", () => {
  it("560/440/360 断点同时改写 .fw-row 与 .fw-list-head 的列轨道", () => {
    for (const width of ["560px", "440px", "360px"]) {
      const block = containerBlock(`@container (max-width: ${width})`);
      expect(block, `missing @container ${width}`).toMatch(/\.fw-row,\s*\.fw-list-head\s*\{/);
    }
  });

  it("次要列在断点里成对隐藏，避免表头与行错位", () => {
    const b560 = containerBlock("@container (max-width: 560px)");
    expect(b560).toContain(".fw-row-type");
    expect(b560).toContain(".fw-list-head .fw-row-type");
    const b440 = containerBlock("@container (max-width: 440px)");
    expect(b440).toContain(".fw-row-size");
    expect(b440).toContain(".fw-list-head .fw-row-size");
  });

  it("表头是滚动容器 .fw-body 的第一个子元素，横向滚动与行天然同源", () => {
    const { container } = render(
      <FileList {...baseProps} entries={[entry]} dirPath="D:\\scroll" viewMode="list" />,
    );
    const body = container.querySelector<HTMLElement>(".fw-body")!;
    expect(body.firstElementChild?.classList.contains("fw-list-head")).toBe(true);
    expect(body.scrollLeft).toBe(0);
  });
});
