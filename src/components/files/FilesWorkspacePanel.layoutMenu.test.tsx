/**
 * @vitest-environment jsdom
 *
 * R10 Agent B：布局「更多」菜单新增「关闭所有空窗格」。
 * - 存在且禁用条件正确（emptyPaneCount>=1 且 paneCount>1 才启用）；
 * - 点击调用 closeAllEmptyPanes 并在关闭数>0 时提示。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridgeMocks = vi.hoisted(() => ({
  fsCopyJobStart: vi.fn(),
  fsDragOut: vi.fn(async (_paths: string[]) => {}),
  fsMoveJobStart: vi.fn(),
  fsDeleteJobStart: vi.fn(),
  fsCopyPaths: vi.fn(),
  fsMovePaths: vi.fn(),
  fsDeletePaths: vi.fn(),
  fsDeleteVerifiedDuplicates: vi.fn(),
  fsPlaces: vi.fn(),
  fsStat: vi.fn(),
  fsJobs: vi.fn(async () => []),
  fsJobStatus: vi.fn(),
  fsJobReport: vi.fn(),
  fsJobCancel: vi.fn(),
  isFileJobTerminal: vi.fn(() => true),
  onRecycleJobProgress: vi.fn(async () => () => {}),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));
vi.mock("./FilePane", () => ({ default: () => <div data-testid="stub-pane" /> }));

import FilesWorkspacePanel from "./FilesWorkspacePanel";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import { FILE_WORKSPACE_SETTING_KEY } from "../../lib/filesWorkspace/persist";
import { cancelFwDrag, clearFwClipboard } from "../../lib/filesWorkspace/interactions";

// 测试 mock 的 useLocale 为 identity（t(key)=key），断言直接用 locale key。
const LABEL = "fw.layout.closeEmptyPanes";
const A = "D:\\pane-a";
const B = "D:\\pane-b";

type SeedTab = { tabId: string; path: string };
type SeedPane = { paneId: string; tabs: SeedTab[]; activeTabId: string | null };

function seedLayout(panes: SeedPane[], activePaneId: string): void {
  const tree =
    panes.length === 1
      ? { type: "pane", paneId: panes[0].paneId }
      : {
          type: "split",
          id: "s1",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "pane", paneId: panes[0].paneId },
          second: { type: "pane", paneId: panes[1].paneId },
        };
  useSettingsStore.setState({
    settings: {
      [FILE_WORKSPACE_SETTING_KEY]: {
        version: 1,
        states: { global: { tree, panes, activePaneId } },
        templates: [],
        recentTemplates: [],
      },
    } as never,
  });
}

async function openMoreMenu(): Promise<void> {
  fireEvent.click(await screen.findByLabelText("fw.toolbar.more"));
  await screen.findByRole("menu");
}

function findItem(): HTMLElement {
  const item = screen
    .getAllByRole("menuitem")
    .find((el) => el.textContent === LABEL) as HTMLElement | undefined;
  if (!item) throw new Error(`菜单项「${LABEL}」不存在`);
  return item;
}

beforeEach(() => {
  Object.values(bridgeMocks).forEach((fn) => vi.mocked(fn).mockClear());
  bridgeMocks.fsPlaces.mockResolvedValue([]);
  bridgeMocks.fsStat.mockResolvedValue([]);
  clearFwClipboard();
});

afterEach(() => {
  cancelFwDrag();
  clearFwClipboard();
  cleanup();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: null });
});

describe("布局菜单：关闭所有空窗格", () => {
  it("有空窗格且窗格数>1 时项存在且启用，点击调用 closeAllEmptyPanes", async () => {
    seedLayout(
      [
        { paneId: "pane-1", tabs: [], activeTabId: null },
        { paneId: "pane-2", tabs: [{ tabId: "t2", path: B }], activeTabId: "t2" },
      ],
      "pane-2",
    );
    render(<FilesWorkspacePanel project={null} />);
    await waitFor(() => expect(useFilesWorkspaceStore.getState().hydrated).toBe(true));
    await openMoreMenu();

    const item = findItem();
    expect(item.getAttribute("aria-disabled")).not.toBe("true");
    const spy = vi
      .spyOn(useFilesWorkspaceStore.getState(), "closeAllEmptyPanes")
      .mockReturnValue(1);
    fireEvent.click(item);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("只有一个窗格时禁用", async () => {
    seedLayout([{ paneId: "pane-1", tabs: [], activeTabId: null }], "pane-1");
    render(<FilesWorkspacePanel project={null} />);
    await waitFor(() => expect(useFilesWorkspaceStore.getState().hydrated).toBe(true));
    await openMoreMenu();

    expect(findItem().getAttribute("aria-disabled")).toBe("true");
  });

  it("没有空窗格时禁用", async () => {
    seedLayout(
      [
        { paneId: "pane-1", tabs: [{ tabId: "t1", path: A }], activeTabId: "t1" },
        { paneId: "pane-2", tabs: [{ tabId: "t2", path: B }], activeTabId: "t2" },
      ],
      "pane-1",
    );
    render(<FilesWorkspacePanel project={null} />);
    await waitFor(() => expect(useFilesWorkspaceStore.getState().hydrated).toBe(true));
    await openMoreMenu();

    expect(findItem().getAttribute("aria-disabled")).toBe("true");
  });
});
