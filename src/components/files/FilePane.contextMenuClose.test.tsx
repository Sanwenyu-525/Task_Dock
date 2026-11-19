/**
 * @vitest-environment jsdom
 *
 * R12 收尾：右键菜单生命周期（打开 → 关闭 → 重新打开）。
 *
 * 不重复实现关闭机制，本文件锁定 `DropdownMenu → Popover` 既有能力在 FilePane
 * 自由定位菜单上的实际表现：
 * - 外部 pointerdown / 窗口失焦 / Escape 关闭；
 * - 菜单项执行后关闭；
 * - 关闭后可在新位置重新打开；
 * - 连续右键不同位置只保留一个菜单实例；
 * - 菜单内部 pointerdown 不误关；
 * - 组件卸载不残留菜单与监听器。
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

const DIR = "D:\\r12-menu";
const NEW_FOLDER = "fw.menu.newFolder";

function entry(name: string) {
  return {
    name,
    kind: "file" as const,
    ext: "txt",
    size: 10,
    modifiedMs: 1700000000000,
    hidden: false,
    category: "text",
  };
}

function hydrate(): void {
  useFilesWorkspaceStore.getState().hydrate(
    {
      tree: { type: "pane", paneId: "pane-1" },
      panes: [{ paneId: "pane-1", tabs: [{ tabId: "tab-1", path: DIR }], activeTabId: "tab-1" }],
      activePaneId: "pane-1",
    },
    "global",
  );
}

function renderPane() {
  return render(
    <FilePane
      paneId="pane-1"
      active
      pageActive
      onHoverZone={() => {}}
      dropHint={null}
      layoutEditMode={false}
      projectRoot={null}
    />,
  );
}

async function openMenuAt(body: HTMLElement, x: number, y: number) {
  const event = createEvent.contextMenu(body, { clientX: x, clientY: y });
  fireEvent(body, event);
  expect(event.defaultPrevented).toBe(true);
  await screen.findByRole("menu");
}

beforeEach(() => {
  memSettings.settings = {};
  clearFwClipboard();
  bridgeMocks.fsListDir.mockReset();
  bridgeMocks.fsDirSignature.mockReset();
  bridgeMocks.fsCreateDir.mockReset();
  bridgeMocks.fsCreateDir.mockResolvedValue(undefined);
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
  bridgeMocks.fsListDir.mockResolvedValue({
    path: DIR,
    truncated: false,
    hasMore: false,
    nextOffset: 1,
    entries: [entry("note.txt")],
  });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await useFilesWorkspaceStore.getState().flushPending();
  await __flushFilesWorkspaceWrites();
});

describe("右键菜单关闭生命周期", () => {
  it("点击菜单外部关闭", async () => {
    hydrate();
    const { container } = renderPane();
    await screen.findByText("note.txt");
    const body = container.querySelector(".fw-body") as HTMLElement;
    expect(body).toBeTruthy();
    await openMenuAt(body, 120, 140);

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("窗口失焦关闭（点击落到 WebView 之外）", async () => {
    hydrate();
    const { container } = renderPane();
    await screen.findByText("note.txt");
    const body = container.querySelector(".fw-body") as HTMLElement;
    expect(body).toBeTruthy();
    await openMenuAt(body, 100, 100);

    fireEvent.blur(window);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("Escape 关闭，且只关这一层", async () => {
    hydrate();
    const { container } = renderPane();
    await screen.findByText("note.txt");
    const body = container.querySelector(".fw-body") as HTMLElement;
    expect(body).toBeTruthy();
    await openMenuAt(body, 160, 170);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("菜单项执行后关闭，并触发对应操作", async () => {
    hydrate();
    const { container } = renderPane();
    await screen.findByText("note.txt");
    const body = container.querySelector(".fw-body") as HTMLElement;
    expect(body).toBeTruthy();
    await openMenuAt(body, 200, 210);

    fireEvent.click(screen.getByText(NEW_FOLDER));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("关闭后再次右键在新位置重新打开（同一时刻只有一个菜单）", async () => {
    hydrate();
    const { container } = renderPane();
    await screen.findByText("note.txt");
    const body = container.querySelector(".fw-body") as HTMLElement;
    expect(body).toBeTruthy();
    await openMenuAt(body, 80, 90);
    expect(screen.getAllByRole("menu")).toHaveLength(1);

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await openMenuAt(body, 320, 260);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("快速连续右键不同位置：不产生多个菜单实例", async () => {
    hydrate();
    const { container } = renderPane();
    await screen.findByText("note.txt");
    const body = container.querySelector(".fw-body") as HTMLElement;
    expect(body).toBeTruthy();
    await openMenuAt(body, 40, 50);

    // 连续两次换位置右键（第二次不再断言 defaultPrevented 之前的状态）。
    fireEvent.contextMenu(body, { clientX: 240, clientY: 260 });
    fireEvent.contextMenu(body, { clientX: 300, clientY: 320 });

    await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(1));
    expect(screen.queryAllByRole("menu")).toHaveLength(1);
  });

  it("菜单内部 pointerdown 不误关（点击菜单项前菜单仍在）", async () => {
    hydrate();
    const { container } = renderPane();
    await screen.findByText("note.txt");
    const body = container.querySelector(".fw-body") as HTMLElement;
    expect(body).toBeTruthy();
    await openMenuAt(body, 90, 95);

    const item = screen.getByText(NEW_FOLDER);
    fireEvent.pointerDown(item);
    expect(screen.queryByRole("menu")).toBeTruthy();
  });

  it("组件卸载时菜单随之移除，后续事件不报错", async () => {
    hydrate();
    const { container, unmount } = renderPane();
    await screen.findByText("note.txt");
    const body = container.querySelector(".fw-body") as HTMLElement;
    expect(body).toBeTruthy();
    await openMenuAt(body, 60, 70);

    unmount();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // 监听器应已移除：再派发同类事件不应抛错或重新打开。
    act(() => {
      fireEvent.pointerDown(document.body);
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
