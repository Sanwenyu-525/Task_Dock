/**
 * @vitest-environment jsdom
 */
//! 空窗格「浏览文件夹」组件测试（第三轮 P0）：
//! - 用户取消系统选择器 → 当前标签与布局**完全不变**；
//! - 选中可读目录 → 在该空窗格里真正打开（不覆盖、不白屏）。
//!
//! 与 `folderPicker.test.ts` 的纯函数测试互补：这里走真实点击 → 原生边界。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  shelfAddPaths: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => dialogMock);
vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));

import FilePane from "./FilePane";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import { paneIds } from "../../lib/filesWorkspace/model";
import {
  bindSettingsStore,
  __flushFilesWorkspaceWrites,
} from "../../lib/filesWorkspace/persist";

const memSettings: { settings: Record<string, unknown>; update: (patch: Record<string, unknown>) => Promise<void> } = {
  settings: {},
  async update(patch) {
    Object.assign(memSettings.settings, patch);
  },
};
bindSettingsStore(() => memSettings);

const DIR = "D:\\browse-target";

function stat(kind: "dir" | "file" | "missing", exists = true) {
  return {
    path: DIR,
    exists,
    kind,
    size: null,
    createdMs: null,
    modifiedMs: null,
    readonly: false,
    hidden: false,
    childCount: 0,
    childTruncated: false,
  };
}

function hydrateEmpty(): void {
  useFilesWorkspaceStore.getState().hydrate(
    {
      tree: { type: "pane", paneId: "pane-1" },
      panes: [{ paneId: "pane-1", tabs: [], activeTabId: null }],
      activePaneId: "pane-1",
    },
    "global",
  );
}

beforeEach(() => {
  dialogMock.open.mockReset();
  bridgeMocks.fsStat.mockReset();
  memSettings.settings = {};
  bridgeMocks.fsListDir.mockResolvedValue({ path: DIR, truncated: false, entries: [] });
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
  hydrateEmpty();
});

afterEach(async () => {
  cleanup();
  await useFilesWorkspaceStore.getState().flushPending();
  await __flushFilesWorkspaceWrites();
});

describe("空窗格浏览文件夹", () => {
  it("取消系统选择器：不新增标签、不改变布局（§4.5）", async () => {
    dialogMock.open.mockResolvedValue(null);
    render(<FilePane paneId="pane-1" active pageActive onHoverZone={() => {}} dropHint={null} layoutEditMode={false} projectRoot={null} />);
    const button = await screen.findByText("fw.pane.browseFolder");
    fireEvent.click(button);
    await waitFor(() => expect(dialogMock.open).toHaveBeenCalled());
    // 取消后仍是原来的单空窗格。
    expect(paneIds(useFilesWorkspaceStore.getState().tree)).toEqual(["pane-1"]);
    expect(useFilesWorkspaceStore.getState().panes["pane-1"].tabs).toHaveLength(0);
  });

  it("选中可读目录：在该窗格打开为新标签", async () => {
    dialogMock.open.mockResolvedValue(DIR);
    bridgeMocks.fsStat.mockResolvedValue([stat("dir")]);
    render(<FilePane paneId="pane-1" active pageActive onHoverZone={() => {}} dropHint={null} layoutEditMode={false} projectRoot={null} />);
    fireEvent.click(await screen.findByText("fw.pane.browseFolder"));
    await waitFor(() => {
      expect(useFilesWorkspaceStore.getState().panes["pane-1"].tabs).toHaveLength(1);
    });
    const tab = useFilesWorkspaceStore.getState().panes["pane-1"].tabs[0];
    expect(tab.path).toBe(DIR);
    // 最近目录同步记录（便于下次空窗格直接打开）。
    expect(useFilesWorkspaceStore.getState().recentDirs).toContain(DIR);
  });

  it("选中后被删除 → 提示错误，页面保持空窗格（不白屏）", async () => {
    dialogMock.open.mockResolvedValue(DIR);
    bridgeMocks.fsStat.mockResolvedValue([stat("missing", false)]);
    render(<FilePane paneId="pane-1" active pageActive onHoverZone={() => {}} dropHint={null} layoutEditMode={false} projectRoot={null} />);
    act(() => {
      fireEvent.click(screen.getByText("fw.pane.browseFolder"));
    });
    await waitFor(() => expect(dialogMock.open).toHaveBeenCalled());
    expect(useFilesWorkspaceStore.getState().panes["pane-1"].tabs).toHaveLength(0);
    // 空态仍在（文案键来自 mock 的 t）。
    expect(screen.getByText("fw.pane.noDir")).toBeTruthy();
  });
});
