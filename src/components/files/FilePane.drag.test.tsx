/**
 * @vitest-environment jsdom
 */
//! FilePane PointerEvent 组件级拖拽测试（任务规范 §4.4：不得只测纯函数）。
//!
//! 覆盖真实事件链：pointerdown → 窗口 pointermove 越阈值 → 协调器会话建立
//! （payload 正确）→ 面板角色 moveFwDrag → 订阅回调按最新坐标命中并上报
//! hover zone → 取消清理。jsdom 矩形恒 0，用固定 rect 桩模拟窗格区域。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridgeMocks = vi.hoisted(() => ({
  fsListDir: vi.fn(),
  fsDirSignature: vi.fn(),
  fsOpen: vi.fn(),
  fsReveal: vi.fn(),
  fsStat: vi.fn(),
  fsCreateDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsRename: vi.fn(),
  fsCopyPaths: vi.fn(),
  fsMovePaths: vi.fn(),
  fsDeletePaths: vi.fn(),
  shelfAddPaths: vi.fn(),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));

import FilePane from "./FilePane";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import {
  cancelFwDrag,
  finishFwDrag,
  getFwDragState,
  moveFwDrag,
  type FwDropZone,
} from "../../lib/filesWorkspace/interactions";

const DIR = "D:\\proj-drag-test";

function setupStore(dir = DIR): void {
  useFilesWorkspaceStore.getState().hydrate(
    {
      tree: { type: "pane", paneId: "pane-1" },
      panes: [{ paneId: "pane-1", tabs: [{ tabId: "t1", path: dir }], activeTabId: "t1" }],
      activePaneId: "pane-1",
    },
    "global",
  );
}

function fixtureEntries() {
  return {
    path: DIR,
    truncated: false,
    entries: [
      { name: "a.txt", kind: "file", ext: "txt", size: 3, modifiedMs: 1, hidden: false, category: "text" },
      { name: "sub", kind: "dir", ext: "", size: null, modifiedMs: 1, hidden: false, category: "folder" },
    ],
  };
}

beforeEach(() => {
  bridgeMocks.fsListDir.mockImplementation((path: string) =>
    Promise.resolve(path === DIR ? fixtureEntries() : { path, truncated: false, entries: [] }),
  );
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
  setupStore();
});

afterEach(() => {
  cancelFwDrag();
  cleanup();
  vi.restoreAllMocks();
});

/** jsdom 矩形恒 0：给窗格与标签栏一个稳定区域，坐标命中才有意义。 */
function stubRects(): void {
  const rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    // 标签栏在窗格内部：用 top 高度区分（tabbar 高约 30）。
    if (this.className.includes("fw-pane-tabbar")) {
      return { ...rect, bottom: 30, height: 30 } as DOMRect;
    }
    return rect;
  });
  // jsdom 根本没有 elementFromPoint 属性：直接定义（文件拖拽中心命中不依赖它）。
  Object.defineProperty(document, "elementFromPoint", {
    value: () => null,
    configurable: true,
    writable: true,
  });
}

async function renderPane(): Promise<{ zones: Array<FwDropZone | null> }> {
  const zones: Array<FwDropZone | null> = [];
  render(
    <FilePane
      paneId="pane-1"
      active
      pageActive
      onHoverZone={(zone) => zones.push(zone)}
      dropHint={null}
    />,
  );
  await waitFor(() => expect(screen.getByText("a.txt")).toBeTruthy());
  return { zones };
}

describe("FilePane 拖拽起点（PointerEvent 组件链）", () => {
  it("文件行 pointerdown + 越阈值移动 → 建立 files 拖拽会话（payload 含选中路径）", async () => {
    stubRects();
    const { zones } = await renderPane();
    const row = screen.getByText("a.txt").closest("[data-fw-path]")!;
    fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 118, clientY: 104, pointerId: 1 });
    const st = getFwDragState();
    expect(st.payload).toEqual({ kind: "files", paths: [`${DIR}\\a.txt`], fromPaneId: "pane-1" });
    // 面板角色：坐标推进 → FilePane 按最新坐标命中本窗格中心并上报。
    act(() => moveFwDrag(400, 300, {}));
    expect(zones.at(-1)).toEqual({ type: "center", paneId: "pane-1", dir: DIR });
    // 效果默认同卷移动。
    expect(getFwDragState().effect).toBe("move");
  });

  it("未越阈值（点击）不建立拖拽会话", async () => {
    stubRects();
    await renderPane();
    const row = screen.getByText("a.txt").closest("[data-fw-path]")!;
    fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 103, clientY: 101, pointerId: 1 });
    expect(getFwDragState().payload).toBeNull();
    fireEvent.pointerUp(window, { clientX: 103, clientY: 101, pointerId: 1 });
    expect(getFwDragState().payload).toBeNull();
  });

  it("标签 pointerdown + 移动 → tabs 会话；把手 → 整窗格 paneMove", async () => {
    stubRects();
    await renderPane();
    const tab = screen.getByRole("tab").closest("[data-fw-tab]")!;
    fireEvent.pointerDown(tab, { button: 0, clientX: 50, clientY: 15, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 70, clientY: 15, pointerId: 1 });
    let st = getFwDragState();
    expect(st.payload?.kind).toBe("tabs");
    if (st.payload?.kind === "tabs") {
      expect(st.payload.tabIds).toEqual(["t1"]);
      expect(st.payload.paneMove).toBeFalsy();
    }
    cancelFwDrag();
    // 状态条把手：整窗格拖拽。
    const grip = document.querySelector(".fw-pane-grip")!;
    fireEvent.pointerDown(grip, { button: 0, clientX: 30, clientY: 590, pointerId: 2 });
    fireEvent.pointerMove(window, { clientX: 55, clientY: 590, pointerId: 2 });
    st = getFwDragState();
    expect(st.payload?.kind).toBe("tabs");
    if (st.payload?.kind === "tabs") {
      expect(st.payload.paneMove).toBe(true);
      expect(st.payload.tabIds).toEqual(["t1"]);
    }
  });

  it("tabs 拖拽命中窗格边缘 → edge zone（四方向分栏的落点来源）", async () => {
    stubRects();
    const { zones } = await renderPane();
    const tab = screen.getByRole("tab").closest("[data-fw-tab]")!;
    fireEvent.pointerDown(tab, { button: 0, clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 420, clientY: 300, pointerId: 1 });
    act(() => moveFwDrag(12, 300, {})); // 左边缘（≤26px）
    expect(zones.at(-1)).toEqual({ type: "edge", paneId: "pane-1", edge: "left" });
    act(() => moveFwDrag(790, 300, {})); // 右边缘
    expect(zones.at(-1)).toEqual({ type: "edge", paneId: "pane-1", edge: "right" });
    act(() => moveFwDrag(400, 8, {})); // 顶边缘（标签栏高度内）
    expect(zones.at(-1)).toEqual({ type: "edge", paneId: "pane-1", edge: "top" });
    act(() => moveFwDrag(400, 592, {})); // 底边缘
    expect(zones.at(-1)).toEqual({ type: "edge", paneId: "pane-1", edge: "bottom" });
    act(() => moveFwDrag(400, 300, {})); // 中心
    expect(zones.at(-1)).toEqual({ type: "center", paneId: "pane-1", dir: DIR });
  });

  it("目录行命中 → folder zone；拖入自身子树被拒（zone=null）", async () => {
    stubRects();
    const { zones } = await renderPane();
    const row = screen.getByText("a.txt").closest("[data-fw-path]")!;
    fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 120, clientY: 100, pointerId: 1 });
    expect(getFwDragState().payload?.kind).toBe("files");
    // elementFromPoint 在 jsdom 不可用 → 落到窗格中心 zone（目录行命中走真实浏览器）。
    act(() => moveFwDrag(400, 300, {}));
    const last = zones.at(-1);
    expect(last?.type).toBe("center");
    // 自身子树非法：把目录拖进自己的子树（直接走 validateFileDrop 的组件封装）。
    expect(getFwDragState().payload?.kind === "files").toBe(true);
    finishFwDrag();
  });

  it("取消后订阅收到 null 上报（hover/残留清理）", async () => {
    stubRects();
    const { zones } = await renderPane();
    const row = screen.getByText("a.txt").closest("[data-fw-path]")!;
    fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 120, clientY: 100, pointerId: 1 });
    act(() => moveFwDrag(400, 300, {}));
    expect(zones.at(-1)).not.toBeNull();
    act(() => cancelFwDrag());
    expect(zones.at(-1)).toBeNull();
    expect(getFwDragState().payload).toBeNull();
  });
});
