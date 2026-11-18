/**
 * @vitest-environment jsdom
 *
 * FilePane 选择交互回归：焦点与选中分离、键盘范围选择、多选拖拽保持整组。
 * 这些断言直接读 Store 与真实 DOM 类，不依赖 FileList 的布局尺寸。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";

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
  clearFwClipboard,
  getFwClipboard,
  getFwDragState,
  setFwClipboard,
  useFwClipboard,
} from "../../lib/filesWorkspace/interactions";

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
  clearFwClipboard();
  setupStore();
});

afterEach(() => {
  cancelFwDrag();
  clearFwClipboard();
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

  it("选中前保留操作条占位：首次选中只切换内容，列表不发生位移", async () => {
    await renderPane();
    const before = document.querySelector<HTMLElement>(".fw-selection-bar");
    expect(before).toBeTruthy();
    expect(before!.classList.contains("is-empty")).toBe(true);
    expect(before!.querySelector("button")).toBeNull();

    fireEvent.pointerDown(screen.getByText("file-00.txt").closest("[data-fw-path]")!, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, { pointerId: 1 });
    await waitFor(() => expect(selectionPaths()).toHaveLength(1));

    const after = document.querySelector<HTMLElement>(".fw-selection-bar");
    expect(after).toBe(before);
    expect(after!.classList.contains("is-empty")).toBe(false);
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

// ── 剪切状态可见化（FW-FILE-004，r9）────────────────────────────────────

describe("剪切状态（FW-FILE-004）", () => {
  it("useFwClipboard 经 useSyncExternalStore 透传权威状态，不复制第二份", () => {
    const { result } = renderHook(() => useFwClipboard());
    expect(result.current).toBeNull();
    act(() => setFwClipboard({ mode: "cut", paths: ["C:\\a"], sourcePaneId: "p" }));
    expect(result.current?.mode).toBe("cut");
    expect(getFwClipboard()).toBe(result.current);
    act(() => clearFwClipboard());
    expect(result.current).toBeNull();
  });

  it("剪切后来源行出现 is-cut；复制覆盖后消失；剪切本身不产生任何文件 IPC", async () => {
    await renderPane();
    const row = () => screen.getByText("file-00.txt").closest("[data-fw-path]")!;
    expect(row().className).not.toContain("is-cut");
    expect(bridgeMocks.fsStat).not.toHaveBeenCalled();

    act(() => {
      setFwClipboard({ mode: "cut", paths: [`${DIR}\\file-00.txt`], sourcePaneId: "pane-1" });
    });
    await waitFor(() => expect(row().className).toContain("is-cut"));
    // 剪切状态本身零文件 IPC（fsStat 未被触发）。
    expect(bridgeMocks.fsStat).not.toHaveBeenCalled();
    expect(bridgeMocks.fsCopyPaths).not.toHaveBeenCalled();
    expect(bridgeMocks.fsMovePaths).not.toHaveBeenCalled();

    // Ctrl+C 等价：copy 覆盖 cut，行恢复普通视觉。
    act(() => {
      setFwClipboard({ mode: "copy", paths: [`${DIR}\\file-00.txt`], sourcePaneId: "pane-1" });
    });
    await waitFor(() => expect(row().className).not.toContain("is-cut"));
  });

  it("路径匹配大小写不敏感；其他目录的同名文件不被误标记", async () => {
    await renderPane();
    const row = () => screen.getByText("file-00.txt").closest("[data-fw-path]")!;
    act(() => {
      setFwClipboard({
        mode: "cut",
        paths: [`d:\\SELECTION-LAB\\FILE-00.TXT`],
        sourcePaneId: "pane-1",
      });
    });
    await waitFor(() => expect(row().className).toContain("is-cut"));

    // 不同目录里的同名文件：完整路径不同，不得被误标为剪切源。
    useFilesWorkspaceStore.getState().openInPane("pane-1", "D:\\other-dir", "replace");
    await waitFor(() => expect(screen.getByText("file-00.txt")).toBeTruthy());
    expect(
      screen.getByText("file-00.txt").closest("[data-fw-path]")!.className,
    ).not.toContain("is-cut");
  });

  it("切到另一窗格后剪切来源状态保持；目标窗格同名文件不标记", async () => {
    useFilesWorkspaceStore.getState().hydrate(
      {
        tree: {
          type: "split",
          id: "s1",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "pane", paneId: "pane-1" },
          second: { type: "pane", paneId: "pane-2" },
        },
        panes: [
          { paneId: "pane-1", tabs: [{ tabId: "t1", path: DIR }], activeTabId: "t1" },
          { paneId: "pane-2", tabs: [{ tabId: "t2", path: "D:\\target-dir" }], activeTabId: "t2" },
        ],
        activePaneId: "pane-1",
      },
      "global",
    );
    const { unmount } = render(
      <>
        <FilePane
          paneId="pane-1"
          active
          pageActive
          dropHint={null}
          layoutEditMode={false}
          projectRoot={null}
          onHoverZone={() => {}}
        />
        <FilePane
          paneId="pane-2"
          active={false}
          pageActive
          dropHint={null}
          layoutEditMode={false}
          projectRoot={null}
          onHoverZone={() => {}}
        />
      </>,
    );
    try {
      await waitFor(() => expect(screen.getAllByText("file-00.txt").length).toBe(2));
      act(() => {
        setFwClipboard({
          mode: "cut",
          paths: [`${DIR}\\file-00.txt`],
          sourcePaneId: "pane-1",
        });
      });
      await waitFor(() =>
        expect(screen.getAllByText("file-00.txt")[0].closest("[data-fw-path]")!.className).toContain(
          "is-cut",
        ),
      );
      // pane-2（D:\target-dir）里的同名文件不标记。
      expect(
        screen.getAllByText("file-00.txt")[1].closest("[data-fw-path]")!.className,
      ).not.toContain("is-cut");
    } finally {
      unmount();
    }
  });

  it("切换列表/网格后剪切状态保持", async () => {
    await renderPane();
    act(() => {
      setFwClipboard({ mode: "cut", paths: [`${DIR}\\file-01.txt`], sourcePaneId: "pane-1" });
    });
    await waitFor(() =>
      expect(screen.getByText("file-01.txt").closest("[data-fw-path]")!.className).toContain("is-cut"),
    );
    const gridBtn = screen.getByLabelText("fw.pane.gridView");
    fireEvent.click(gridBtn);
    // 网格卡片复用同一 data-fw-path 命中（fw-cell.is-cut）。
    await waitFor(() =>
      expect(screen.getByText("file-01.txt").closest("[data-fw-path]")!.className).toContain("is-cut"),
    );
    fireEvent.click(screen.getByLabelText("fw.pane.listView"));
    await waitFor(() =>
      expect(screen.getByText("file-01.txt").closest("[data-fw-path]")!.className).toContain("is-cut"),
    );
  });

  it("空白菜单：无剪贴板时粘贴禁用；剪切后出现「取消剪切」入口并可一键清空", async () => {
    await renderPane();
    const openBlankMenu = async () => {
      const body = document.querySelector<HTMLElement>(".fw-body")!;
      fireEvent.contextMenu(body, { clientX: 12, clientY: 300 });
      await waitFor(() => expect(screen.getByText("fw.menu.paste")).toBeTruthy());
    };
    await openBlankMenu();
    // DropdownMenu 的禁用语义是 aria-disabled + is-disabled 类，不是 disabled 属性。
    expect(
      screen.getByText("fw.menu.paste").closest("button")!.getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(document.querySelector(".ui-dialog-root") ?? document.body);
    cleanup();

    await renderPane();
    act(() => {
      setFwClipboard({
        mode: "cut",
        paths: [`${DIR}\\file-00.txt`, `${DIR}\\file-01.txt`],
        sourcePaneId: "pane-1",
      });
    });
    await openBlankMenu();
    expect(
      screen.getByText("fw.menu.paste").closest("button")!.getAttribute("aria-disabled"),
    ).toBeNull();
    const cancelCut = screen.getByText("fw.menu.cancelCut");
    expect(cancelCut).toBeTruthy();
    fireEvent.click(cancelCut);
    await waitFor(() => expect(getFwClipboard()).toBeNull());
  });

  it("右键「剪切」菜单建立剪切 payload；状态建立不触发文件 IPC", async () => {
    await renderPane();
    const row = screen.getByText("file-02.txt").closest("[data-fw-path]")!;
    fireEvent.contextMenu(row, { clientX: 100, clientY: 130 });
    await waitFor(() => expect(screen.getByText("fw.menu.cut")).toBeTruthy());
    fireEvent.click(screen.getByText("fw.menu.cut"));
    await waitFor(() => expect(getFwClipboard()?.mode).toBe("cut"));
    expect(getFwClipboard()?.paths).toEqual([`${DIR}\\file-02.txt`]);
    expect(getFwClipboard()?.sourcePaneId).toBe("pane-1");
    expect(bridgeMocks.fsStat).not.toHaveBeenCalled();
    expect(bridgeMocks.fsCopyPaths).not.toHaveBeenCalled();
    expect(bridgeMocks.fsMovePaths).not.toHaveBeenCalled();
  });

  it("25,000 项目录：剪切路径集合 O(1) 命中，渲染无明显性能回退", async () => {
    bridgeMocks.fsListDir.mockResolvedValue(fixtureEntries(25000));
    await renderPane();
    const paths = Array.from({ length: 25000 }, (_, i) => `${DIR}\\file-${String(i).padStart(2, "0")}.txt`);
    const started = Date.now();
    act(() => {
      setFwClipboard({ mode: "cut", paths, sourcePaneId: "pane-1" });
    });
    await waitFor(() =>
      expect(screen.getByText("file-00.txt").closest("[data-fw-path]")!.className).toContain("is-cut"),
    );
    const elapsed = Date.now() - started;
    // 25k 路径建 Set + 单行命中应远低于交互阈值；这里给 3s 环境余量。
    expect(elapsed).toBeLessThan(3000);
  });
});
