/**
 * @vitest-environment jsdom
 *
 * A06 文件工作区：滚动锚点恢复与缓存有界的定向回归（第六轮）。
 * - 以「首个可见文件 + 视口内偏移」为锚点，中间条目重排/替换也能回到原文件；
 * - 锚点文件被删除时落到名称最近邻，条目减少时钳制到有效滚动范围；
 * - 同一路径两个标签位置独立；顶部 0 可保存/恢复；列表↔网格不跨模式恢复；
 * - LRU 有界且活跃标签受保护；关闭标签经 prune 释放缓存；网格模式按行/列恢复。
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  __resetScrollCache();
});

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: (key: string) => key,
  }),
}));

import FileList, {
  __resetScrollCache,
  __scrollCacheForTest,
  pruneScrollSessions,
  type FileListProps,
} from "./FileList";
import type { FsEntry } from "../../lib/bridge";

const LIST_ROW_H = 26;
const HEAD_H = 26;
const GRID_ROW_H = 116 + 8;

const entry = (name: string, index: number): FsEntry => ({
  name,
  kind: "file",
  ext: "txt",
  size: 100 + index,
  modifiedMs: 1,
  hidden: false,
  category: "text",
});

const many = Array.from({ length: 60 }, (_, i) => entry(`file-${String(i).padStart(3, "0")}.txt`, i));
const few = many.slice(0, 4);

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

function bodyOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".fw-body")!;
}

function scrollOf(container: HTMLElement | null): number {
  return container?.querySelector<HTMLElement>(".fw-body")?.scrollTop ?? -1;
}

function mount(props: Partial<FileListProps> & { entries: FsEntry[]; dirPath: string; viewMode: "list" | "grid" }) {
  return render(<FileList {...baseProps} {...props} />);
}

/** 按列表几何换算「当前首个可见条目」的名称，验证恢复到了正确文件。 */
function firstVisibleListName(container: HTMLElement, entries: FsEntry[]): string {
  const scrollTop = scrollOf(container);
  const index = Math.max(0, Math.floor(Math.max(0, scrollTop - HEAD_H) / LIST_ROW_H));
  return entries[Math.min(index, entries.length - 1)]?.name ?? "";
}

function scrollAndRemember(
  view: ReturnType<typeof mount>,
  top: number,
): void {
  const body = bodyOf(view.container);
  body.scrollTop = top;
  body.dispatchEvent(new Event("scroll"));
}

describe("滚动锚点恢复", () => {
  it("中间条目重排（数量/首末不变）后仍恢复到原锚点文件", () => {
    const dir = "D:\\anchor-reorder";
    const first = mount({ entries: many, dirPath: dir, viewMode: "list", sessionKey: "tab:reorder" });
    // 312 = 表头 26 + 第 11 行？按几何为 (312-26)/26 ≈ 11.9 → 首可见 file-011。
    // 为了断言直观，滚到 338 = 表头 + 12×26，首可见 file-012。
    scrollAndRemember(first, 338);
    expect(firstVisibleListName(first.container, many)).toBe("file-012.txt");
    cleanup();

    // 删除 file-005（锚点之前），插入 file-020a（锚点之后）：数量/首末不变，
    // 但 file-012 的索引从 12 变为 11。旧「首末签名」会错误恢复到 file-013。
    const reordered = [...many.filter((item) => item.name !== "file-005.txt")];
    reordered.splice(
      reordered.findIndex((item) => item.name === "file-021.txt"),
      0,
      entry("file-020a.txt", 20),
    );
    const second = mount({ entries: reordered, dirPath: dir, viewMode: "list", sessionKey: "tab:reorder" });
    expect(scrollOf(second.container)).toBe(HEAD_H + 11 * LIST_ROW_H);
    expect(firstVisibleListName(second.container, reordered)).toBe("file-012.txt");
  });

  it("锚点文件被删除时落到名称最近邻，而不是旧像素位置上的无关文件", () => {
    const dir = "D:\\anchor-deleted";
    const first = mount({ entries: many, dirPath: dir, viewMode: "list", sessionKey: "tab:deleted" });
    scrollAndRemember(first, 338);
    cleanup();

    const withoutAnchor = many.filter((item) => item.name !== "file-012.txt");
    const second = mount({ entries: withoutAnchor, dirPath: dir, viewMode: "list", sessionKey: "tab:deleted" });
    expect(scrollOf(second.container)).toBe(HEAD_H + 12 * LIST_ROW_H);
    expect(firstVisibleListName(second.container, withoutAnchor)).toBe("file-013.txt");
  });

  it("条目减少时把锚点钳制到有效滚动范围之内", () => {
    const dir = "D:\\shrink";
    const first = mount({ entries: many, dirPath: dir, viewMode: "list", sessionKey: "tab:shrink" });
    scrollAndRemember(first, 338);
    cleanup();

    const second = mount({ entries: few, dirPath: dir, viewMode: "list", sessionKey: "tab:shrink" });
    const restored = scrollOf(second.container);
    // jsdom clientHeight 为 0：有效上限 = 条目数 × 行高。
    expect(restored).toBe(HEAD_H + 3 * LIST_ROW_H);
    expect(restored).toBeLessThanOrEqual(few.length * LIST_ROW_H);
    expect(firstVisibleListName(second.container, few)).toBe("file-003.txt");
  });

  it("滚回顶部保存 0，重挂载后恢复为 0", () => {
    const dir = "D:\\back-to-top";
    const first = mount({ entries: many, dirPath: dir, viewMode: "list", sessionKey: "tab:top" });
    scrollAndRemember(first, 338);
    scrollAndRemember(first, 0);
    cleanup();

    const second = mount({ entries: many, dirPath: dir, viewMode: "list", sessionKey: "tab:top" });
    expect(scrollOf(second.container)).toBe(0);
    expect(firstVisibleListName(second.container, many)).toBe("file-000.txt");
  });

  it("同一路径两个标签的锚点位置独立，互不覆盖", () => {
    const dir = "D:\\same-dir";
    const first = mount({ entries: many, dirPath: dir, viewMode: "list", sessionKey: "tab:t1" });
    scrollAndRemember(first, 338);
    cleanup();

    const second = mount({ entries: many, dirPath: dir, viewMode: "list", sessionKey: "tab:t2" });
    scrollAndRemember(second, 676);
    cleanup();

    const restore1 = mount({ entries: many, dirPath: dir, viewMode: "list", sessionKey: "tab:t1" });
    expect(scrollOf(restore1.container)).toBe(338);
    cleanup();

    const restore2 = mount({ entries: many, dirPath: dir, viewMode: "list", sessionKey: "tab:t2" });
    expect(scrollOf(restore2.container)).toBe(676);
  });

  it("列表 ↔ 网格切换不跨模式恢复；切回列表仍保留原列表锚点", () => {
    const dir = "D:\\mode-switch";
    const first = mount({ entries: many, dirPath: dir, viewMode: "list", sessionKey: "tab:mode" });
    scrollAndRemember(first, 338);
    cleanup();

    const grid = mount({ entries: many, dirPath: dir, viewMode: "grid", sessionKey: "tab:mode" });
    expect(scrollOf(grid.container)).toBe(0);
    cleanup();

    const listAgain = mount({ entries: many, dirPath: dir, viewMode: "list", sessionKey: "tab:mode" });
    expect(scrollOf(listAgain.container)).toBe(338);
  });

  it("网格模式按行/列锚定，条目重排后恢复到原单元格所在行", () => {
    const dir = "D:\\grid-anchor";
    const first = mount({ entries: many, dirPath: dir, viewMode: "grid", sessionKey: "tab:grid" });
    scrollAndRemember(first, 2 * GRID_ROW_H);
    cleanup();

    // 删除 file-002（锚点前），插入 file-020a（锚点后）：file-004 的索引 4 → 3，
    // 网格 2 列（jsdom 宽度为 0 时最小 2 列），恢复行从 2 → 1。
    const reordered = many.filter((item) => item.name !== "file-002.txt");
    reordered.splice(
      reordered.findIndex((item) => item.name === "file-021.txt"),
      0,
      entry("file-020a.txt", 20),
    );
    const second = mount({ entries: reordered, dirPath: dir, viewMode: "grid", sessionKey: "tab:grid" });
    expect(scrollOf(second.container)).toBe(1 * GRID_ROW_H);
  });
});

describe("缓存容量与释放", () => {
  it("LRU 有界：超容量淘汰非活跃会话，活跃标签位置受保护", () => {
    const { remember, cache, active, max } = __scrollCacheForTest;
    for (let i = 0; i < max; i += 1) {
      remember(`tab:inactive-${i}`, { anchorName: `f${i}.txt`, anchorOffset: 10 + i, viewMode: "list" });
    }
    active.add("tab:active-1");
    active.add("tab:active-2");
    remember("tab:active-1", { anchorName: "a1.txt", anchorOffset: 300, viewMode: "list" });
    remember("tab:active-2", { anchorName: "a2.txt", anchorOffset: 301, viewMode: "list" });

    expect(cache.size).toBeLessThanOrEqual(max);
    expect(cache.has("tab:active-1")).toBe(true);
    expect(cache.has("tab:active-2")).toBe(true);
  });

  it("pruneScrollSessions 释放已关闭标签的缓存，保留存活标签与路径兜底", () => {
    const { remember, cache } = __scrollCacheForTest;
    remember("tab:alive", { anchorName: "a.txt", anchorOffset: 120, viewMode: "list" });
    remember("tab:closed", { anchorName: "b.txt", anchorOffset: 90, viewMode: "list" });
    remember("path:D:\\fallback", { anchorName: "c.txt", anchorOffset: 40, viewMode: "list" });

    pruneScrollSessions(new Set(["alive"]));

    expect(cache.has("tab:alive")).toBe(true);
    expect(cache.has("tab:closed")).toBe(false);
    expect(cache.has("path:D:\\fallback")).toBe(true);
  });
});
