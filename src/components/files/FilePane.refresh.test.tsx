/**
 * @vitest-environment jsdom
 *
 * R12：刷新目录的前端反馈与并发。
 * - 点击立即进入 loading（旋转 + aria-busy + 状态条「正在刷新」）；
 * - 成功结束并短暂显示「已更新」；
 * - 失败显示行内错误且保留旧列表（不变空目录）；
 * - 连续点击合并为一次 IPC；
 * - 工具栏与右键菜单共用同一刷新入口；
 * - 不同窗格的刷新状态互相独立。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";

const dialogMock = vi.hoisted(() => ({ open: vi.fn() }));
const bridgeMocks = vi.hoisted(() => ({
  fsListDir: vi.fn(),
  fsDirSignature: vi.fn(),
  fsStat: vi.fn(),
  fsOpen: vi.fn(),
  fsReveal: vi.fn(),
  fsCreateDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsRename: vi.fn(),
  fsCopyPaths: vi.fn(),
  fsMovePaths: vi.fn(),
  fsDeletePaths: vi.fn(),
  fsOpenWith: vi.fn(),
  fsOpenTerminal: vi.fn(),
  fsShowProperties: vi.fn(),
  shelfAddPaths: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => dialogMock);
vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));

import FilePane from "./FilePane";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import { bindSettingsStore, __flushFilesWorkspaceWrites } from "../../lib/filesWorkspace/persist";
import { clearFwClipboard } from "../../lib/filesWorkspace/interactions";

const memSettings = {
  settings: {} as Record<string, unknown>,
  async update(patch: Record<string, unknown>) {
    Object.assign(memSettings.settings, patch);
  },
};
bindSettingsStore(() => memSettings);

const DIR = "D:\\r12-refresh";
const DIR_B = "D:\\r12-refresh-b";

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
let pending: Deferred[] = [];

function listing(path: string, names: string[]) {
  return {
    path,
    truncated: false,
    hasMore: false,
    nextOffset: names.length,
    entries: names.map((name) => ({
      name,
      kind: "file" as const,
      ext: "txt",
      size: 10,
      modifiedMs: 1700000000000,
      hidden: false,
      category: "text",
    })),
  };
}

function hydrate(twoPanes = false): void {
  if (!twoPanes) {
    useFilesWorkspaceStore.getState().hydrate(
      {
        tree: { type: "pane", paneId: "pane-1" },
        panes: [{ paneId: "pane-1", tabs: [{ tabId: "tab-1", path: DIR }], activeTabId: "tab-1" }],
        activePaneId: "pane-1",
      },
      "global",
    );
    return;
  }
  useFilesWorkspaceStore.getState().hydrate(
    {
      tree: {
        type: "split",
        id: "split-1",
        direction: "horizontal",
        ratio: 0.5,
        first: { type: "pane", paneId: "pane-1" },
        second: { type: "pane", paneId: "pane-2" },
      },
      panes: [
        { paneId: "pane-1", tabs: [{ tabId: "tab-1", path: DIR }], activeTabId: "tab-1" },
        { paneId: "pane-2", tabs: [{ tabId: "tab-2", path: DIR_B }], activeTabId: "tab-2" },
      ],
      activePaneId: "pane-1",
    },
    "global",
  );
}

function pane(paneId = "pane-1") {
  return (
    <FilePane
      paneId={paneId}
      active
      pageActive
      onHoverZone={() => {}}
      dropHint={null}
      layoutEditMode={false}
      projectRoot={null}
    />
  );
}

const refreshButton = () => screen.getByLabelText("fw.pane.refresh");

beforeEach(() => {
  memSettings.settings = {};
  pending = [];
  clearFwClipboard();
  bridgeMocks.fsListDir.mockReset();
  bridgeMocks.fsDirSignature.mockReset();
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
  bridgeMocks.fsListDir.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
});

afterEach(async () => {
  cleanup();
  for (const item of pending.splice(0)) item.resolve(listing(DIR, []));
  vi.restoreAllMocks();
  await useFilesWorkspaceStore.getState().flushPending();
  await __flushFilesWorkspaceWrites();
});

describe("刷新目录反馈", () => {
  it("点击立即进入 loading；连续点击合并为一次请求；成功后显示已更新", async () => {
    hydrate();
    render(pane());
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve(listing(DIR, ["old.txt"])));
    await screen.findByText("old.txt");

    fireEvent.click(refreshButton());

    // 同步可见的过程反馈：按钮 aria-busy + 状态条文案（不是 Toast）。
    expect(refreshButton().getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("fw.refresh.refreshing")).toBeTruthy();
    // 刷新期间旧列表保留，不闪空态。
    expect(screen.getByText("old.txt")).toBeTruthy();

    // 连续点击不再发新请求。
    fireEvent.click(refreshButton());
    fireEvent.click(refreshButton());
    expect(pending).toHaveLength(2);

    act(() => pending[1].resolve(listing(DIR, ["new.txt"])));
    await screen.findByText("new.txt");
    await waitFor(() => expect(refreshButton().getAttribute("aria-busy")).toBe("false"));
    expect(screen.getByText("fw.refresh.updated")).toBeTruthy();
    expect(screen.queryByText("old.txt")).toBeNull();
  });

  it("刷新失败：结束 loading、显示行内错误、保留旧列表", async () => {
    hydrate();
    render(pane());
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve(listing(DIR, ["keep.txt"])));
    await screen.findByText("keep.txt");

    fireEvent.click(refreshButton());
    act(() => pending[1].reject(new Error("permission denied")));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("fw.refresh.failed");
    expect(refreshButton().getAttribute("aria-busy")).toBe("false");
    // 失败不得把已有列表变成空目录。
    expect(screen.getByText("keep.txt")).toBeTruthy();
    expect(screen.queryByText("fw.pane.emptyDir")).toBeNull();
  });

  it("右键菜单刷新与工具栏共用同一入口", async () => {
    hydrate();
    const { container } = render(pane());
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve(listing(DIR, ["before.txt"])));
    await screen.findByText("before.txt");

    const body = container.querySelector(".fw-body") as HTMLElement;
    const event = createEvent.contextMenu(body, { clientX: 120, clientY: 130 });
    fireEvent(body, event);
    await screen.findByRole("menu");
    fireEvent.click(screen.getByText("fw.menu.refresh"));

    expect(pending).toHaveLength(2);
    act(() => pending[1].resolve(listing(DIR, ["after.txt"])));
    await screen.findByText("after.txt");
    await waitFor(() => expect(screen.getByText("fw.refresh.updated")).toBeTruthy());
  });

  it("不同窗格的刷新状态互相独立", async () => {
    hydrate(true);
    render(
      <>
        {pane("pane-1")}
        {pane("pane-2")}
      </>,
    );
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => {
      pending[0].resolve(listing(DIR, ["a.txt"]));
      pending[1].resolve(listing(DIR_B, ["b.txt"]));
    });
    await screen.findByText("a.txt");
    await screen.findByText("b.txt");

    const buttons = screen.getAllByLabelText("fw.pane.refresh");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);

    // 只有被点击的窗格进入刷新态。
    expect(buttons[0].getAttribute("aria-busy")).toBe("true");
    expect(buttons[1].getAttribute("aria-busy")).toBe("false");
    expect(screen.getAllByText("fw.refresh.refreshing")).toHaveLength(1);

    act(() => pending[2].resolve(listing(DIR, ["a2.txt"])));
    await screen.findByText("a2.txt");
    expect(screen.getByText("b.txt")).toBeTruthy();
  });
});
