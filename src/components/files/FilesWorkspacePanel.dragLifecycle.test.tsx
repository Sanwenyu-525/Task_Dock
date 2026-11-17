/**
 * @vitest-environment jsdom
 *
 * 文件工作区：应用内拖拽会话生命周期（第六轮 P1，任务 A，面板级）。
 *
 * 挂载真实 FilesWorkspacePanel（FilePane 用桩替代，行内 pointerdown 由协调器直接
 * 建立会话），走面板真实注册的 window/document 监听（onUp / onCancel / onKey /
 * onLeaveDoc），直接断言桥接 IPC `fsCopyPaths` / `fsMovePaths` 调用次数：
 * - 取消通道（Escape / pointercancel / blur / 指针离开文档 / 卸载 / 连续拖动）：
 *   会话清空且 copy/move IPC 为 0；
 * - 正常释放：默认安全复制 → `fsCopyPaths` 恰一次；Shift 按住 → `fsMovePaths` 恰一次。
 *
 * 说明：本文件只做挂载与事件驱动，不修改面板源码；FilePane 候选指针层的回归见
 * FilePane.cancel.test.tsx。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const bridgeMocks = vi.hoisted(() => ({
  fsCopyPaths: vi.fn(),
  fsMovePaths: vi.fn(),
  fsDeletePaths: vi.fn(),
  fsDeleteVerifiedDuplicates: vi.fn(),
  fsPlaces: vi.fn(),
  fsStat: vi.fn(),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (k: string) => k, locale: "zh-CN" }),
}));
// 行内 pointerdown/hover 计算由协调器直接驱动，面板 UI 用桩即可。
vi.mock("./FilePane", () => ({ default: () => <div data-testid="stub-pane" /> }));

import FilesWorkspacePanel from "./FilesWorkspacePanel";
import { useSettingsStore } from "../../store/useSettingsStore";
import { FILE_WORKSPACE_SETTING_KEY } from "../../lib/filesWorkspace/persist";
import {
  cancelFwDrag,
  getFwDragState,
  isFwDragging,
  moveFwDrag,
  startFwDrag,
  updateFwHover,
} from "../../lib/filesWorkspace/interactions";

const SRC = "D:\\src";
const DST = "D:\\dst";
const SOURCE_FILE = `${SRC}\\a.txt`;

const report = {
  operationId: "test-op",
  attempted: 1,
  ok: 1,
  failed: 0,
  skipped: 0,
  partial: 0,
  entries: [],
};

function seedTwoPaneLayout(): void {
  useSettingsStore.setState({
    settings: {
      [FILE_WORKSPACE_SETTING_KEY]: persistedLayout(),
    } as never,
  });
}

function persistedLayout() {
  return {
    version: 1,
    states: {
      global: {
        tree: {
          type: "split",
          id: "s1",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "pane", paneId: "pane-1" },
          second: { type: "pane", paneId: "pane-2" },
        },
        panes: [
          { paneId: "pane-1", tabs: [{ tabId: "t1", path: SRC }], activeTabId: "t1" },
          { paneId: "pane-2", tabs: [{ tabId: "t2", path: DST }], activeTabId: "t2" },
        ],
        activePaneId: "pane-1",
      },
    },
    templates: [],
    recentTemplates: [],
  };
}

/** 建立 files 会话并把落点登记到 pane-2 中心（等价目标窗格订阅上报）。 */
function startFilesDrag(): void {
  act(() => {
    startFwDrag({ kind: "files", paths: [SOURCE_FILE], fromPaneId: "pane-1" }, 100, 100);
  });
  act(() => {
    updateFwHover({ type: "center", paneId: "pane-2", dir: DST }, "pane-2");
  });
}

function expectNoFileIpc(): void {
  expect(bridgeMocks.fsCopyPaths).not.toHaveBeenCalled();
  expect(bridgeMocks.fsMovePaths).not.toHaveBeenCalled();
  expect(bridgeMocks.fsDeletePaths).not.toHaveBeenCalled();
}

beforeEach(() => {
  Object.values(bridgeMocks).forEach((fn) => vi.mocked(fn).mockClear());
  bridgeMocks.fsCopyPaths.mockResolvedValue(report);
  bridgeMocks.fsMovePaths.mockResolvedValue(report);
  bridgeMocks.fsPlaces.mockResolvedValue([]);
  bridgeMocks.fsStat.mockResolvedValue([
    { path: `${DST}\\a.txt`, exists: false, kind: "file", modifiedMs: 1, size: 1 },
  ]);
  seedTwoPaneLayout();
});

afterEach(() => {
  cancelFwDrag();
  cleanup();
  useSettingsStore.setState({ settings: null });
});

describe("面板级拖拽取消通道：不执行真实文件操作", () => {
  it("Escape 取消：会话清空，copy/move/delete IPC 0", async () => {
    render(<FilesWorkspacePanel project={null} />);
    startFilesDrag();
    expect(isFwDragging()).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(isFwDragging()).toBe(false);
    expect(getFwDragState().payload).toBeNull();
    expect(getFwDragState().hover).toBeNull();
    expectNoFileIpc();
  });

  it("pointercancel 取消：会话清空，IPC 0", async () => {
    render(<FilesWorkspacePanel project={null} />);
    startFilesDrag();

    fireEvent.pointerCancel(window, { pointerId: 1 });

    expect(isFwDragging()).toBe(false);
    expectNoFileIpc();
  });

  it("窗口失焦(blur)取消：会话清空，IPC 0", async () => {
    render(<FilesWorkspacePanel project={null} />);
    startFilesDrag();

    fireEvent.blur(window);

    expect(isFwDragging()).toBe(false);
    expectNoFileIpc();
  });

  it("指针离开文档（relatedTarget 为空）取消：会话清空，IPC 0", async () => {
    render(<FilesWorkspacePanel project={null} />);
    startFilesDrag();

    document.dispatchEvent(new PointerEvent("pointerleave", { relatedTarget: null }));

    expect(isFwDragging()).toBe(false);
    expectNoFileIpc();
  });

  it("拖动中卸载面板：监听回收并取消会话，IPC 0", async () => {
    const { unmount } = render(<FilesWorkspacePanel project={null} />);
    startFilesDrag();

    unmount();

    expect(isFwDragging()).toBe(false);
    expectNoFileIpc();
  });

  it("快速连续两次拖动后均取消：无残留会话，IPC 0", async () => {
    render(<FilesWorkspacePanel project={null} />);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      startFilesDrag();
      expect(isFwDragging()).toBe(true);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(isFwDragging()).toBe(false);
    }
    expectNoFileIpc();
  });
});

describe("面板级正常释放：IPC 恰为预期", () => {
  it("默认安全复制：pointerup 后 fsCopyPaths 恰一次，目标目录与路径正确", async () => {
    render(<FilesWorkspacePanel project={null} />);
    startFilesDrag();

    fireEvent.pointerUp(window, { pointerId: 1 });

    await waitFor(() => expect(bridgeMocks.fsCopyPaths).toHaveBeenCalledTimes(1));
    expect(bridgeMocks.fsMovePaths).not.toHaveBeenCalled();
    const [paths, targetDir] = bridgeMocks.fsCopyPaths.mock.calls[0];
    expect(paths).toEqual([SOURCE_FILE]);
    expect(targetDir).toBe(DST);
  });

  it("Shift 按住：解析为移动，pointerup 后 fsMovePaths 恰一次", async () => {
    render(<FilesWorkspacePanel project={null} />);
    startFilesDrag();
    act(() => moveFwDrag(undefined, undefined, { shiftKey: true }));

    fireEvent.pointerUp(window, { pointerId: 1 });

    await waitFor(() => expect(bridgeMocks.fsMovePaths).toHaveBeenCalledTimes(1));
    expect(bridgeMocks.fsCopyPaths).not.toHaveBeenCalled();
    const [paths, targetDir] = bridgeMocks.fsMovePaths.mock.calls[0];
    expect(paths).toEqual([SOURCE_FILE]);
    expect(targetDir).toBe(DST);
  });

  it("无合法落点（hover 为空）时 pointerup 早退，不产生 IPC", async () => {
    render(<FilesWorkspacePanel project={null} />);
    act(() => {
      startFwDrag({ kind: "files", paths: [SOURCE_FILE], fromPaneId: "pane-1" }, 100, 100);
    });
    // 不登记 hover。

    fireEvent.pointerUp(window, { pointerId: 1 });

    expectNoFileIpc();
  });
});
