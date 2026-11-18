/**
 * @vitest-environment jsdom
 *
 * 文件属性对话框回归（FW-INFO-001，r9）：旧夹具/后端缺字段时按空值兜底，
 * 一个缺失字段不得让整个属性对话框崩进 error boundary。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));

import FilePane from "./FilePane";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import { useUiStore } from "../../store/useUiStore";
import { cancelFwDrag, clearFwClipboard } from "../../lib/filesWorkspace/interactions";

const DIR = "D:\\props-lab";

function fixtureEntries() {
  return {
    path: DIR,
    truncated: false,
    entries: [
      { name: "a.txt", kind: "file", ext: "txt", size: 123, modifiedMs: 1700000000000, hidden: false, category: "text" },
      { name: "b.txt", kind: "file", ext: "txt", size: 456, modifiedMs: 1700000000000, hidden: false, category: "text" },
      { name: "folder", kind: "dir", ext: "", size: null, modifiedMs: 1700000000000, hidden: false, category: "folder" },
    ],
  };
}

function fullStat(path: string, overrides: Record<string, unknown> = {}) {
  const name = path.split(/[\\/]/).pop() ?? path;
  const isDir = name === "folder";
  return {
    path,
    exists: true,
    kind: isDir ? "dir" : "file",
    size: isDir ? null : 123,
    createdMs: 1690000000000,
    modifiedMs: 1700000000000,
    accessedMs: 1700000001000,
    attributes: isDir ? ["directory"] : ["archive"],
    readonly: false,
    hidden: false,
    childCount: isDir ? 2 : null,
    childTruncated: false,
    ...overrides,
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
  await waitFor(() => expect(screen.getByText("a.txt")).toBeTruthy());
}

async function openProps(entryName: string): Promise<void> {
  const row = screen.getByText(entryName).closest("[data-fw-path]")!;
  fireEvent.contextMenu(row, { clientX: 100, clientY: 120 });
  await waitFor(() => expect(screen.getByText("fw.menu.props")).toBeTruthy());
  fireEvent.click(screen.getByText("fw.menu.props"));
}

/** 属性对话框根节点（role="dialog" 的面板），行内同名文件不参与查询。 */
function propsDialog(): HTMLElement {
  const title = screen.getByText("fw.props.title");
  const root = title.closest('[role="dialog"]');
  if (!root) throw new Error("属性对话框未打开");
  return root as HTMLElement;
}

beforeEach(() => {
  bridgeMocks.fsListDir.mockResolvedValue(fixtureEntries());
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
  bridgeMocks.fsOpen.mockResolvedValue(undefined);
  bridgeMocks.fsStat.mockImplementation(async (paths: string[]) =>
    paths.map((path) => fullStat(path)),
  );
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
});

describe("属性对话框（FW-INFO-001）", () => {
  it("普通文件：完整字段如实展示（含访问时间与属性）", async () => {
    await renderPane();
    await openProps("a.txt");
    await waitFor(() => expect(screen.getByText("fw.props.title")).toBeTruthy());
    const dialog = within(propsDialog());
    expect(dialog.getByText("a.txt")).toBeTruthy();
    expect(dialog.getByText("fw.props.attr.archive")).toBeTruthy();
    expect(dialog.getByText("fw.props.path")).toBeTruthy();
    // 访问时间行有可读值（非「—」占位）。
    const accessedRow = dialog.getByText("fw.props.accessed").parentElement!;
    expect(accessedRow.textContent).not.toContain("—");
  });

  it("文件夹：显示子项计数与 directory 属性", async () => {
    await renderPane();
    await openProps("folder");
    await waitFor(() => expect(screen.getByText("fw.props.title")).toBeTruthy());
    const dialog = within(propsDialog());
    expect(dialog.getByText("fw.props.attr.directory")).toBeTruthy();
    expect(dialog.getByText("fw.props.childCount", { exact: false })).toBeTruthy();
  });

  it("缺失访问时间与空属性数组：显示占位，不崩溃", async () => {
    bridgeMocks.fsStat.mockResolvedValue([
      fullStat(`${DIR}\\a.txt`, { accessedMs: null, attributes: [] }),
    ]);
    await renderPane();
    await openProps("a.txt");
    await waitFor(() => expect(screen.getByText("fw.props.title")).toBeTruthy());
    const dialog = within(propsDialog());
    expect(dialog.getByText("fw.props.attributesEmpty")).toBeTruthy();
    const accessedRow = dialog.getByText("fw.props.accessed").parentElement!;
    expect(accessedRow.textContent).toContain("—");
  });

  it("属性字段整体缺失（旧夹具）：attributes undefined 不再抛 TypeError 进 error boundary", async () => {
    // r8 走查踩到的崩溃：mock 返回缺 attributes/accessedMs 的旧结构。
    bridgeMocks.fsStat.mockResolvedValue([
      {
        path: `${DIR}\\a.txt`,
        exists: true,
        kind: "file",
        size: 123,
        createdMs: 1690000000000,
        modifiedMs: 1700000000000,
        readonly: false,
        hidden: false,
        childCount: null,
        childTruncated: false,
      } as never,
    ]);
    await renderPane();
    await openProps("a.txt");
    await waitFor(() => expect(screen.getByText("fw.props.title")).toBeTruthy());
    const dialog = within(propsDialog());
    expect(dialog.getByText("fw.props.attributesEmpty")).toBeTruthy();
    expect(dialog.getByText("a.txt")).toBeTruthy();
  });

  it("读取失败：toast 报错且不打开对话框", async () => {
    bridgeMocks.fsStat.mockRejectedValue(new Error("FS_OP_INVALID_PATH"));
    await renderPane();
    await openProps("a.txt");
    await waitFor(() => {
      const toasts = useUiStore.getState().toasts;
      expect(toasts.at(-1)?.kind).toBe("error");
      expect((toasts.at(-1)?.message ?? "").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("fw.props.title")).toBeNull();
  });

  it("快速切换文件：最后一次读取获胜，对话框显示新条目", async () => {
    await renderPane();
    await openProps("a.txt");
    await openProps("b.txt");
    await waitFor(() => expect(screen.getByText("fw.props.title")).toBeTruthy());
    expect(bridgeMocks.fsStat).toHaveBeenCalledTimes(2);
    // 两次读取都已完成，最后一次 setPropsData 生效：对话框停留在 b.txt。
    expect(within(propsDialog()).getByText("b.txt")).toBeTruthy();
  });
});
