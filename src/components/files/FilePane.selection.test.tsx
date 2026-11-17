/**
 * @vitest-environment jsdom
 *
 * FilePane 选择交互回归：焦点与选中分离、键盘范围选择、多选拖拽保持整组。
 * 这些断言直接读 Store 与真实 DOM 类，不依赖 FileList 的布局尺寸。
 */

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
import { cancelFwDrag, getFwDragState } from "../../lib/filesWorkspace/interactions";

const DIR = "D:\\selection-lab";

function fixtureEntries(count = 10) {
  return {
    path: DIR,
    truncated: false,
    entries: Array.from({ length: count }, (_, index) => ({
      name: `file-${String(index).padStart(2, "0")}.txt`,
      kind: "file",
      ext: "txt",
      size: index,
      modifiedMs: 1,
      hidden: false,
      category: "text",
    })),
  };
}

function setupStore(): void {
  useFilesWorkspaceStore.getState().hydrate(
    {
      tree: { type: "pane", paneId: "pane-1" },
      panes: [{ paneId: "pane-1", tabs: [{ tabId: "t1", path: DIR }], activeTabId: "t1" }],
      activePaneId: "pane-1",
    },
    "global",
  );
}

beforeEach(() => {
  bridgeMocks.fsListDir.mockResolvedValue(fixtureEntries());
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
  bridgeMocks.fsOpen.mockResolvedValue(undefined);
  setupStore();
});

afterEach(() => {
  cancelFwDrag();
  cleanup();
  vi.clearAllMocks();
});

async function renderPane(): Promise<void> {
  render(
    <FilePane
      paneId="pane-1"
      active
      pageActive
      dropHint={null}
      layoutEditMode={false}
      projectRoot={null}
      onHoverZone={() => {}}
    />,
  );
  await waitFor(() => expect(screen.getByText("file-00.txt")).toBeTruthy());
}

function selectionPaths(): string[] {
  return useFilesWorkspaceStore.getState().selection["pane-1"]?.paths ?? [];
}

describe("FilePane 键盘焦点与选择", () => {
  it("方向键移动焦点并单选；Ctrl+方向只移动焦点不改变选中集合", async () => {
    await renderPane();
    fireEvent.pointerDown(screen.getByText("file-00.txt").closest("[data-fw-path]")!, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(selectionPaths()).toEqual([`${DIR}\\file-00.txt`]);

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(selectionPaths()).toEqual([`${DIR}\\file-01.txt`]));

    const activeRow = screen.getByText("file-01.txt").closest("[data-fw-path]")!;
    fireEvent.keyDown(window, { key: "ArrowDown", ctrlKey: true });
    await waitFor(() => expect(selectionPaths()).toEqual([`${DIR}\\file-01.txt`]));
    const focusedRow = screen.getByText("file-02.txt").closest("[data-fw-path]")!;
    expect(focusedRow.className).toContain("is-active");
    expect(activeRow.className).not.toContain("is-active");
  });

  it("Shift+方向从锚点扩展选择，焦点行保持独立 active", async () => {
    await renderPane();
    const row0 = screen.getByText("file-00.txt").closest("[data-fw-path]")!;
    fireEvent.pointerDown(row0, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.keyDown(window, { key: "ArrowDown", shiftKey: true });
    await waitFor(() =>
      expect(selectionPaths()).toEqual([`${DIR}\\file-00.txt`, `${DIR}\\file-01.txt`]),
    );
    const row1 = screen.getByText("file-01.txt").closest("[data-fw-path]")!;
    expect(row1.className).toContain("is-active");
    expect(useFilesWorkspaceStore.getState().selection["pane-1"]?.anchor).toBe(
      `${DIR}\\file-00.txt`,
    );
  });

  it("Enter 打开焦点文件，而不是仅打开唯一选中项", async () => {
    await renderPane();
    fireEvent.pointerDown(screen.getByText("file-00.txt").closest("[data-fw-path]")!, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.keyDown(window, { key: "ArrowDown", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByText("file-01.txt").closest("[data-fw-path]")!.className).toContain(
        "is-active",
      ),
    );
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(bridgeMocks.fsOpen).toHaveBeenCalledWith(`${DIR}\\file-01.txt`));
  });

  it("输入框内方向键不被文件选择消费", async () => {
    await renderPane();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selectionPaths()).toEqual([]);
    input.remove();
  });
});

describe("右键保留多选 / 未选项调整选择", () => {
  it("右键已选项保留整组；右键未选项替换为该项", async () => {
    await renderPane();
    const rows = ["file-00.txt", "file-01.txt", "file-02.txt"].map(
      (name) => screen.getByText(name).closest("[data-fw-path]")!,
    );
    fireEvent.pointerDown(rows[0], { button: 0, clientX: 100, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    for (let i = 1; i < 3; i += 1) {
      fireEvent.pointerDown(rows[i], {
        button: 0,
        clientX: 100,
        clientY: 90 + i * 20,
        pointerId: 1,
        ctrlKey: true,
      });
      fireEvent.pointerUp(window, { pointerId: 1 });
    }
    await waitFor(() => expect(selectionPaths()).toHaveLength(3));

    fireEvent.contextMenu(rows[1], { clientX: 100, clientY: 110 });
    expect(selectionPaths()).toHaveLength(3);
    const unselected = screen.getByText("file-04.txt").closest("[data-fw-path]")!;
    fireEvent.contextMenu(unselected, { clientX: 100, clientY: 150 });
    await waitFor(() => expect(selectionPaths()).toEqual([`${DIR}\\file-04.txt`]));
  });
});

describe("框选后多选拖拽保持整组", () => {
  it("Escape 取消框选时恢复按下前选择集合", async () => {
    await renderPane();
    const row0 = screen.getByText("file-00.txt").closest("[data-fw-path]")!;
    fireEvent.pointerDown(row0, { button: 0, clientX: 100, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(selectionPaths()).toEqual([`${DIR}\\file-00.txt`]);

    const body = document.querySelector<HTMLElement>(".fw-body")!;
    Object.defineProperty(body, "clientWidth", { value: 600, configurable: true });
    Object.defineProperty(body, "clientHeight", { value: 360, configurable: true });
    body.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 600, bottom: 360, width: 600, height: 360, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(body, { button: 0, clientX: 10, clientY: 56, pointerId: 7 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 118, pointerId: 7 });
    await waitFor(() => expect(selectionPaths()).toHaveLength(3));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(selectionPaths()).toEqual([`${DIR}\\file-00.txt`]));
  });

  it("矩形框选三行后从已选项拖动，payload 保持三条路径", async () => {
    await renderPane();
    const body = document.querySelector<HTMLElement>(".fw-body")!;
    Object.defineProperty(body, "clientWidth", { value: 600, configurable: true });
    Object.defineProperty(body, "clientHeight", { value: 360, configurable: true });
    body.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 600, bottom: 360, width: 600, height: 360, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    // 表头 26px 之下：屏幕 y=56..118 对应内容 y=30..92，覆盖第 1/2/3 行。
    fireEvent.pointerDown(body, { button: 0, clientX: 10, clientY: 56, pointerId: 7 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 118, pointerId: 7 });
    await waitFor(() => expect(selectionPaths()).toHaveLength(3));
    fireEvent.pointerUp(window, { clientX: 300, clientY: 118, pointerId: 7 });
    expect(bridgeMocks.fsCopyPaths).not.toHaveBeenCalled();
    expect(bridgeMocks.fsMovePaths).not.toHaveBeenCalled();
    expect(bridgeMocks.fsDeletePaths).not.toHaveBeenCalled();

    const row1 = screen.getByText("file-01.txt").closest("[data-fw-path]")!;
    fireEvent.pointerDown(row1, { button: 0, clientX: 100, clientY: 110, pointerId: 8 });
    fireEvent.pointerMove(window, { clientX: 118, clientY: 130, pointerId: 8 });
    await waitFor(() => expect(getFwDragState().payload?.kind).toBe("files"));
    expect(getFwDragState().payload).toEqual({
      kind: "files",
      paths: [`${DIR}\\file-01.txt`, `${DIR}\\file-02.txt`, `${DIR}\\file-03.txt`],
      fromPaneId: "pane-1",
    });
    act(() => cancelFwDrag());
    fireEvent.pointerUp(window, { pointerId: 8 });
  });

  it("三个文件选中后从其中一项拖动，payload 仍是三条路径", async () => {
    await renderPane();
    const rows = ["file-00.txt", "file-01.txt", "file-02.txt"].map(
      (name) => screen.getByText(name).closest("[data-fw-path]")!,
    );
    fireEvent.pointerDown(rows[0], { button: 0, clientX: 100, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.pointerDown(rows[1], {
      button: 0,
      clientX: 100,
      clientY: 110,
      pointerId: 1,
      ctrlKey: true,
    });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.pointerDown(rows[2], {
      button: 0,
      clientX: 100,
      clientY: 130,
      pointerId: 1,
      ctrlKey: true,
    });
    fireEvent.pointerUp(window, { pointerId: 1 });
    await waitFor(() => expect(selectionPaths()).toHaveLength(3));

    fireEvent.pointerDown(rows[1], { button: 0, clientX: 100, clientY: 110, pointerId: 2 });
    fireEvent.pointerMove(window, { clientX: 118, clientY: 130, pointerId: 2 });
    await waitFor(() => expect(getFwDragState().payload?.kind).toBe("files"));
    const payload = getFwDragState().payload;
    expect(payload).toEqual({
      kind: "files",
      paths: [`${DIR}\\file-00.txt`, `${DIR}\\file-01.txt`, `${DIR}\\file-02.txt`],
      fromPaneId: "pane-1",
    });
    act(() => cancelFwDrag());
    fireEvent.pointerUp(window, { pointerId: 2 });
  });
});
