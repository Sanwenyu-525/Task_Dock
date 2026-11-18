/**
 * @vitest-environment jsdom
 *
 * 系统集成动作错误反馈（FW-SYS-001，r9）：打开方式 / 终端 / Windows 属性等
 * Shell 动作失败不再被 `.catch(() => {})` 吞掉——必须出现用户可见的 toast
 * （错误 toast 落入 useUiStore），且诊断只记录一次。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridgeMocks = vi.hoisted(() => ({
  fsListDir: vi.fn(),
  fsDirSignature: vi.fn(),
  fsOpen: vi.fn(),
  fsReveal: vi.fn(),
  fsStat: vi.fn(),
  fsCreateDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsRename: vi.fn(),
  fsDeleteJobStart: vi.fn(),
  fsOpenWith: vi.fn(),
  fsOpenTerminal: vi.fn(),
  fsShowProperties: vi.fn(),
  shelfAddPaths: vi.fn(),
}));

const diagnosticsMocks = vi.hoisted(() => ({
  isLogged: vi.fn(() => false),
  logEvent: vi.fn(),
  startOperation: vi.fn(),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../lib/diagnostics", () => diagnosticsMocks);
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));

import FilePane from "./FilePane";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import { useUiStore } from "../../store/useUiStore";
import { cancelFwDrag, clearFwClipboard } from "../../lib/filesWorkspace/interactions";

const DIR = "D:\\sys-lab";

function fixtureEntries() {
  return {
    path: DIR,
    truncated: false,
    entries: [
      { name: "doc.txt", kind: "file", ext: "txt", size: 12, modifiedMs: 1, hidden: false, category: "text" },
    ],
  };
}

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
  await waitFor(() => expect(screen.getByText("doc.txt")).toBeTruthy());
}

/** 右键菜单触发一个系统动作菜单项。 */
async function invokeMenuAction(entryLabel: string): Promise<void> {
  const row = screen.getByText("doc.txt").closest("[data-fw-path]")!;
  fireEvent.contextMenu(row, { clientX: 100, clientY: 120 });
  await waitFor(() => expect(screen.getByText(entryLabel)).toBeTruthy());
  fireEvent.click(screen.getByText(entryLabel));
}

function lastToast(): { message: string; kind: string } | undefined {
  const toasts = useUiStore.getState().toasts;
  return toasts.at(-1);
}

beforeEach(() => {
  bridgeMocks.fsListDir.mockResolvedValue(fixtureEntries());
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
  bridgeMocks.fsOpen.mockResolvedValue(undefined);
  bridgeMocks.fsReveal.mockResolvedValue(undefined);
  bridgeMocks.fsOpenWith.mockResolvedValue(undefined);
  bridgeMocks.fsOpenTerminal.mockResolvedValue(undefined);
  bridgeMocks.fsShowProperties.mockResolvedValue(undefined);
  clearFwClipboard();
  useFilesWorkspaceStore.getState().hydrate(
    {
      tree: { type: "pane", paneId: "pane-1" },
      panes: [{ paneId: "pane-1", tabs: [{ tabId: "t1", path: DIR }], activeTabId: "t1" }],
      activePaneId: "pane-1",
    },
    "global",
  );
});

afterEach(() => {
  cancelFwDrag();
  clearFwClipboard();
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ toast: null, toasts: [] });
});

describe("系统集成动作错误反馈（FW-SYS-001）", () => {
  it("成功调用：命令各执行一次，无错误 toast", async () => {
    await renderPane();
    await invokeMenuAction("fw.menu.openWith");
    await waitFor(() => expect(bridgeMocks.fsOpenWith).toHaveBeenCalledWith(`${DIR}\\doc.txt`));
    await invokeMenuAction("fw.menu.openTerminal");
    await waitFor(() => expect(bridgeMocks.fsOpenTerminal).toHaveBeenCalledWith(`${DIR}\\doc.txt`));
    await invokeMenuAction("fw.menu.nativeProps");
    await waitFor(() =>
      expect(bridgeMocks.fsShowProperties).toHaveBeenCalledWith(`${DIR}\\doc.txt`),
    );
    const errorToasts = useUiStore.getState().toasts.filter((toast) => toast.kind === "error");
    expect(errorToasts).toHaveLength(0);
    expect(diagnosticsMocks.logEvent).not.toHaveBeenCalled();
  });

  it("「打开方式」IPC 失败：不吞异常，出现可读错误 toast 并记录一次诊断", async () => {
    bridgeMocks.fsOpenWith.mockRejectedValue(new Error("SHELL_EXECUTE_FAILED"));
    await renderPane();
    await invokeMenuAction("fw.menu.openWith");
    await waitFor(() => {
      const toast = lastToast();
      expect(toast?.kind).toBe("error");
      expect(toast?.message).toContain("fw.error.systemAction");
    });
    // t 为透传 mock：动作名与错误详情都进入同一条消息，不重复弹窗。
    const errorToasts = useUiStore.getState().toasts.filter((toast) => toast.kind === "error");
    expect(errorToasts).toHaveLength(1);
    expect(diagnosticsMocks.logEvent).toHaveBeenCalledTimes(1);
    expect(diagnosticsMocks.logEvent.mock.calls[0][0]).toMatchObject({
      level: "ERROR",
      module: "fileWorkspace",
      event: "system-action-failed",
    });
  });

  it("「在终端中打开」失败同样可见反馈（三个 Shell 入口统一出口）", async () => {
    bridgeMocks.fsOpenTerminal.mockRejectedValue(new Error("ACCESS_DENIED"));
    await renderPane();
    await invokeMenuAction("fw.menu.openTerminal");
    await waitFor(() => {
      const toast = lastToast();
      // t 为透传 mock：键即消息本体；错误详情经 diagnostics metadata 断言。
      expect(toast?.kind).toBe("error");
      expect(toast?.message).toBe("fw.error.systemAction");
    });
    const lastEvent = diagnosticsMocks.logEvent.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(lastEvent?.metadata ?? {})).toContain("ACCESS_DENIED");
  });

  it("「Windows 属性」失败可见；成功后诊断保持干净", async () => {
    bridgeMocks.fsShowProperties.mockRejectedValue(new Error("NO_ASSOCIATION"));
    await renderPane();
    await invokeMenuAction("fw.menu.nativeProps");
    await waitFor(() => expect(lastToast()?.kind).toBe("error"));
    expect(bridgeMocks.fsShowProperties).toHaveBeenCalledWith(`${DIR}\\doc.txt`);
  });

  it("已归属（isLogged=true）的 IPC 错误不重复记录诊断，但 toast 仍然出现", async () => {
    diagnosticsMocks.isLogged.mockReturnValue(true);
    bridgeMocks.fsOpenWith.mockRejectedValue(new Error("ALREADY_REPORTED"));
    await renderPane();
    await invokeMenuAction("fw.menu.openWith");
    await waitFor(() => expect(lastToast()?.kind).toBe("error"));
    expect(diagnosticsMocks.logEvent).not.toHaveBeenCalled();
  });
});
