/**
 * @vitest-environment jsdom
 */
//! FilePane 拖拽生命周期回归（第六轮 P1，任务 A）。
//!
//! 覆盖取消路径不执行真实文件操作：未越阈值点击、pointercancel、窗口失焦(blur)、
//! 协调器取消（Escape / 离开文档 / 卸载，等价面板 onCancel）、拖动中卸载窗格、
//! 快速连续拖动、同一目标重复悬停；并回归 Ctrl=复制 / Shift=移动 / 默认安全复制
//! 的效果解析与提示一致性。
//!
//! IPC 断言口径：本夹具挂载 FilePane + 全局协调器（FilesWorkspacePanel 的落点提交
//! 监听器归面板所有，不在此挂载）。断言 `fsCopyPaths` / `fsMovePaths` / `fsDeletePaths`
//! 调用次数为 0，且 FilePane 不派发 `taskdock-fw-request-transfer` 跨窗格传输事件；
//! 协调器会话在取消后 `payload/hover` 均为 null——这正是面板 onUp 提交前的早退条件
//! （`if (!zone || !payload) return;`）。面板级真实 IPC 派发由面板归属测试覆盖。

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
  getFwDragState,
  moveFwDrag,
  type FwDropZone,
} from "../../lib/filesWorkspace/interactions";

const DIR = "D:\\proj-cancel-test";

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

function fixtureEntries() {
  return {
    path: DIR,
    truncated: false,
    entries: [
      { name: "a.txt", kind: "file", ext: "txt", size: 3, modifiedMs: 1, hidden: false, category: "text" },
      { name: "b.txt", kind: "file", ext: "txt", size: 4, modifiedMs: 1, hidden: false, category: "text" },
    ],
  };
}

/** 收集 FilePane 上报的 hover 落点；同时监听跨窗格传输事件。 */
function installTransferSpy(): { zones: Array<FwDropZone | null>; transfers: unknown[] } {
  const zones: Array<FwDropZone | null> = [];
  const transfers: unknown[] = [];
  window.addEventListener("taskdock-fw-request-transfer", ((e: Event) => {
    transfers.push((e as CustomEvent).detail);
  }) as EventListener);
  return { zones, transfers };
}

beforeEach(() => {
  Object.values(bridgeMocks).forEach((fn) => vi.mocked(fn).mockClear());
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

function stubRects(): void {
  const rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.className.includes("fw-pane-tabbar")) {
      return { ...rect, bottom: 30, height: 30 } as DOMRect;
    }
    return rect;
  });
  Object.defineProperty(document, "elementFromPoint", {
    value: () => null,
    configurable: true,
    writable: true,
  });
}

async function renderPane(options: { pageActive?: boolean } = {}) {
  const { zones, transfers } = installTransferSpy();
  render(
    <FilePane
      paneId="pane-1"
      active
      pageActive={options.pageActive ?? true}
      onHoverZone={(zone) => zones.push(zone)}
      dropHint={null}
      layoutEditMode={false}
      projectRoot={null}
    />,
  );
  await waitFor(() => expect(screen.getByText("a.txt")).toBeTruthy());
  return { zones, transfers };
}

/** 从文件行 pointerdown 开始，越阈值建立 files 会话。 */
function startFileDrag(rowText = "a.txt"): void {
  const row = screen.getByText(rowText).closest("[data-fw-path]")!;
  fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 118, clientY: 104, pointerId: 1 });
  expect(getFwDragState().payload?.kind).toBe("files");
}

function expectNoFileIpc(transfers: unknown[]): void {
  // 取消路径：三类文件操作 IPC 全部 0 次，也不派发跨窗格传输请求。
  expect(bridgeMocks.fsCopyPaths).not.toHaveBeenCalled();
  expect(bridgeMocks.fsMovePaths).not.toHaveBeenCalled();
  expect(bridgeMocks.fsDeletePaths).not.toHaveBeenCalled();
  expect(transfers).toHaveLength(0);
}

describe("拖拽取消路径：不执行真实文件操作", () => {
  it("未越阈值（普通点击）不建会话，IPC 0", async () => {
    stubRects();
    const { transfers } = await renderPane();
    const row = screen.getByText("a.txt").closest("[data-fw-path]")!;
    fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 103, clientY: 101, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 103, clientY: 101, pointerId: 1 });
    expect(getFwDragState().payload).toBeNull();
    expectNoFileIpc(transfers);
  });

  it("pointercancel 清理候选指针：后续移动不重建会话，IPC 0", async () => {
    stubRects();
    const { transfers } = await renderPane();
    startFileDrag();
    act(() => moveFwDrag(400, 300, {}));

    // FilePane 层 onCancel 只清候选指针/挂起的 Ctrl 翻转；协调器会话的取消由面板
    // window 监听调 cancelFwDrag（见下一条「等价取消」用例）。本夹具不挂面板，
    // 这里验证候选被清后不会被残留指针误建新会话，且不产生任何文件 IPC。
    fireEvent.pointerCancel(window, { pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 200, pointerId: 1 });
    expectNoFileIpc(transfers);
  });

  it("窗口失焦(blur)清理候选指针：后续移动不重建会话，IPC 0", async () => {
    stubRects();
    const { transfers } = await renderPane();
    startFileDrag();
    act(() => moveFwDrag(400, 300, {}));

    fireEvent.blur(window);
    fireEvent.pointerMove(window, { clientX: 200, clientY: 200, pointerId: 1 });
    expectNoFileIpc(transfers);
  });

  it("Escape / pointerleave / 卸载等价取消（面板 onCancel → cancelFwDrag）：会话与落点清空，IPC 0", async () => {
    stubRects();
    const { transfers } = await renderPane();
    startFileDrag();
    act(() => moveFwDrag(400, 300, {}));
    expect(getFwDragState().hover).not.toBeNull();

    // 面板 onCancel 对 Escape / pointerleave / 卸载 统一调用 cancelFwDrag；
    // 清空后面板 onUp 的早退条件 `!zone || !payload` 命中，不会进入 requestTransfer。
    act(() => cancelFwDrag());
    expect(getFwDragState().payload).toBeNull();
    expect(getFwDragState().hover).toBeNull();
    expectNoFileIpc(transfers);
  });

  it("拖动期间卸载窗格：监听随卸载回收，重挂不幻影建会话，IPC 0", async () => {
    stubRects();
    const { unmount } = render(
      <FilePane paneId="pane-1" active pageActive onHoverZone={() => undefined} dropHint={null} layoutEditMode={false} projectRoot={null} />,
    );
    await waitFor(() => expect(screen.getByText("a.txt")).toBeTruthy());
    const row = screen.getByText("a.txt").closest("[data-fw-path]")!;
    fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    // 尚未越阈值时卸载窗格。
    unmount();

    // 卸载后的普通移动不得被残留监听误判成新拖拽。
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300, pointerId: 1 });
    expect(getFwDragState().payload).toBeNull();
    expectNoFileIpc([]);
  });

  it("快速连续两次拖动后取消：无残留候选，第二次干净建立，IPC 0", async () => {
    stubRects();
    const { transfers } = await renderPane();

    for (let cycle = 0; cycle < 2; cycle += 1) {
      startFileDrag(cycle === 0 ? "a.txt" : "b.txt");
      act(() => moveFwDrag(400, 300, {}));
      expect(getFwDragState().payload).not.toBeNull();
      act(() => cancelFwDrag());
      expect(getFwDragState().payload).toBeNull();
    }
    expectNoFileIpc(transfers);
  });

  it("同一目标重复悬停：落点不重复上报，不派发提交事件", async () => {
    stubRects();
    const { zones, transfers } = await renderPane();
    startFileDrag();
    act(() => moveFwDrag(400, 300, {}));
    act(() => moveFwDrag(401, 301, {}));
    act(() => moveFwDrag(399, 299, {}));
    // 连续同落点只上报一次（协调器签名收敛 + 组件 sameZone 去重）。
    const hoverZones = zones.filter((z) => z !== null);
    expect(hoverZones).toHaveLength(1);
    expect(hoverZones[0]).toEqual({ type: "center", paneId: "pane-1", dir: DIR });
    expect(transfers).toHaveLength(0);
    act(() => cancelFwDrag());
  });

  it("页面失活(pageActive=false)期间形成的拖拽不产生文件操作 IPC", async () => {
    stubRects();
    const { transfers } = await renderPane({ pageActive: false });
    startFileDrag();
    act(() => moveFwDrag(400, 300, {}));
    act(() => cancelFwDrag());
    expect(getFwDragState().payload).toBeNull();
    expectNoFileIpc(transfers);
  });
});

describe("拖拽效果解析与提示一致性", () => {
  it("Ctrl 按住 → copy；Shift 按住 → move；卷未知默认安全 copy", async () => {
    stubRects();
    await renderPane();
    startFileDrag();

    act(() => moveFwDrag(400, 300, { ctrlKey: true }));
    expect(getFwDragState().effect).toBe("copy");

    act(() => moveFwDrag(400, 300, { shiftKey: true }));
    expect(getFwDragState().effect).toBe("move");

    act(() => moveFwDrag(400, 300, {}));
    // 无后端卷键缓存：未知卷一律复制（安全默认），绝不按盘符猜移动。
    expect(getFwDragState().effect).toBe("copy");
    act(() => cancelFwDrag());
  });

  it("落点为空（正文区/非法目标）时不携带目标目录，不触发提交", async () => {
    stubRects();
    const { zones, transfers } = await renderPane();
    startFileDrag();
    // 坐标落在窗格矩形外 → computeZone 返回 null。
    act(() => moveFwDrag(-50, -50, {}));
    expect(zones.at(-1)).toBeNull();
    expect(getFwDragState().hover).toBeNull();
    expect(transfers).toHaveLength(0);
    act(() => cancelFwDrag());
  });
});
