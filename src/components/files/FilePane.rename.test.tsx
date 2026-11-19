/**
 * @vitest-environment jsdom
 *
 * R10 Agent B：目录/文件改名成功后同步标签路径。
 * 走真实 UI：右键条目 → 重命名 → 确认，断言 fsRename 成功调用 remapTabPaths(旧路径, 新路径)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));

import FilePane from "./FilePane";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import {
  bindSettingsStore,
  __flushFilesWorkspaceWrites,
} from "../../lib/filesWorkspace/persist";

const memSettings: {
  settings: Record<string, unknown>;
  update: (patch: Record<string, unknown>) => Promise<void>;
} = {
  settings: {},
  async update(patch) {
    Object.assign(memSettings.settings, patch);
  },
};
bindSettingsStore(() => memSettings);

const DIR = "D:\\rename-lab";
const OLD_PATH = `${DIR}\\old`;
const NEW_PATH = `${DIR}\\new`;

/** 文件行：标签栏/面包屑也会显示 "old"，按 data-fw-path 精确锁定列表行。 */
async function findEntryRow(): Promise<HTMLElement> {
  await screen.findAllByText("old");
  const row = screen
    .getAllByText("old")
    .map((el) => el.closest("[data-fw-path]") as HTMLElement | null)
    .find((el): el is HTMLElement => Boolean(el));
  if (!row) throw new Error("未找到条目行");
  return row;
}

beforeEach(() => {
  memSettings.settings = {};
  bridgeMocks.fsListDir.mockResolvedValue({
    path: DIR,
    truncated: false,
    entries: [
      { name: "old", kind: "dir", ext: "", size: null, modifiedMs: 1, hidden: false, category: "folder" },
    ],
  });
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
  bridgeMocks.fsRename.mockResolvedValue(undefined);
  useFilesWorkspaceStore.getState().hydrate(
    {
      tree: { type: "pane", paneId: "pane-1" },
      panes: [{ paneId: "pane-1", tabs: [{ tabId: "t1", path: DIR }], activeTabId: "t1" }],
      activePaneId: "pane-1",
    },
    "global",
  );
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await useFilesWorkspaceStore.getState().flushPending();
  await __flushFilesWorkspaceWrites();
});

describe("改名成功后同步标签路径", () => {
  it("fsRename 成功 → remapTabPaths(旧完整路径, 新完整路径)", async () => {
    render(
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
    const row = await findEntryRow();
    fireEvent.contextMenu(row, { clientX: 100, clientY: 120 });
    await waitFor(() => expect(screen.getByText("fw.menu.rename")).toBeTruthy());
    fireEvent.click(screen.getByText("fw.menu.rename"));

    const input = await screen.findByDisplayValue("old");
    fireEvent.change(input, { target: { value: "new" } });

    const remap = vi
      .spyOn(useFilesWorkspaceStore.getState(), "remapTabPaths")
      .mockReturnValue(1);
    fireEvent.click(screen.getByText("common.confirm"));

    await waitFor(() => expect(bridgeMocks.fsRename).toHaveBeenCalledWith(OLD_PATH, "new"));
    expect(remap).toHaveBeenCalledTimes(1);
    expect(remap).toHaveBeenCalledWith(OLD_PATH, NEW_PATH);
  });

  it("fsRename 失败 → 不调用 remapTabPaths", async () => {
    bridgeMocks.fsRename.mockRejectedValueOnce(new Error("拒绝访问"));
    render(
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
    const row = await findEntryRow();
    fireEvent.contextMenu(row, { clientX: 100, clientY: 120 });
    fireEvent.click(await screen.findByText("fw.menu.rename"));
    fireEvent.change(await screen.findByDisplayValue("old"), { target: { value: "new" } });

    const remap = vi
      .spyOn(useFilesWorkspaceStore.getState(), "remapTabPaths")
      .mockReturnValue(0);
    fireEvent.click(screen.getByText("common.confirm"));

    await waitFor(() => expect(bridgeMocks.fsRename).toHaveBeenCalled());
    expect(remap).not.toHaveBeenCalled();
  });
});
