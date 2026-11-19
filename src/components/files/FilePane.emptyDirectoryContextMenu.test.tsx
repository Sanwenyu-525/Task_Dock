/**
 * @vitest-environment jsdom
 *
 * R11 P1：**真实空目录**的内容区右键必须走 TaskDock 空白菜单，不能漏到 WebView2 原生菜单。
 *
 * 根因（已通过代码审查定位）：`FilePane.tsx` 的内容区有三种渲染分支，只有 `FileList` 的
 * `.fw-body` 绑定了 `onBodyContextMenu`；`visibleEntries.length === 0` 的 `.fw-body-empty`
 * 分支没有绑定任何右键事件，于是空目录（以及搜索无结果）直接落到浏览器默认菜单。
 *
 * 本文件锁定四种情况互不串味：
 * A 正常目录 + 文件条目 → `onEntryContextMenu`（条目菜单）；
 * B 正常目录 + 列表空白 → `onBodyContextMenu`（目录空白菜单）；
 * C 空目录 / 搜索无结果 + 内容区空白 → `onBodyContextMenu`（目录空白菜单）；
 * D 真·空窗格（tabs=[]）→ `onEmptyContextMenu`（空窗格专用菜单），不能被当成 C。
 *
 * 断言必须落在真实渲染出的 `role="menu"` 与菜单项上，而不是只 spy `setMenu`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

/** 测试 mock 的 t(key)=key，因此菜单断言直接用 locale key。 */
const NEW_FOLDER = "fw.menu.newFolder";
const NEW_FILE = "fw.menu.newFile";
const PASTE = "fw.menu.paste";
const REFRESH = "fw.menu.refresh";
const HIDDEN = "fw.menu.showHidden";
const ENTER = "fw.menu.enter";
const EMPTY_DIR_TEXT = "fw.pane.emptyDir";
const NO_MATCH_TEXT = "fw.pane.noMatch";
const BROWSE_FOLDER = "fw.pane.browseFolder";

function entry(name: string, kind: "file" | "dir") {
  return {
    name,
    kind,
    ext: kind === "dir" ? "" : name.split(".").pop() ?? "",
    size: kind === "dir" ? null : 128,
    modifiedMs: 1700000000000,
    hidden: false,
    category: kind === "dir" ? "folder" : "text",
  };
}

function hydrateDir(path: string, tabId = "tab-1"): void {
  useFilesWorkspaceStore.getState().hydrate(
    {
      tree: { type: "pane", paneId: "pane-1" },
      panes: [{ paneId: "pane-1", tabs: [{ tabId, path }], activeTabId: tabId }],
      activePaneId: "pane-1",
    },
    "global",
  );
}

function hydrateEmptyPane(): void {
  useFilesWorkspaceStore.getState().hydrate(
    {
      tree: { type: "pane", paneId: "pane-1" },
      panes: [{ paneId: "pane-1", tabs: [], activeTabId: null }],
      activePaneId: "pane-1",
    },
    "global",
  );
}

function renderPane(): ReturnType<typeof render> {
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

function menuLabels(): string[] {
  return screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
}

beforeEach(() => {
  memSettings.settings = {};
  clearFwClipboard();
  bridgeMocks.fsListDir.mockReset();
  bridgeMocks.fsDirSignature.mockReset();
  bridgeMocks.fsCreateDir.mockReset();
  bridgeMocks.fsCreateDir.mockResolvedValue(undefined);
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await useFilesWorkspaceStore.getState().flushPending();
  await __flushFilesWorkspaceWrites();
});

describe("C 真实空目录（0 项）内容区右键", () => {
  it("阻止 WebView2 默认菜单，并弹出真实 TaskDock 空白菜单", async () => {
    const DIR = "D:\\r11-empty";
    bridgeMocks.fsListDir.mockResolvedValue({ path: DIR, truncated: false, hasMore: false, nextOffset: 0, entries: [] });
    hydrateDir(DIR);
    renderPane();

    const emptyBody = (await screen.findByText(EMPTY_DIR_TEXT)).closest(".fw-body-empty") as HTMLElement;
    expect(emptyBody).toBeTruthy();

    const ev = createEvent.contextMenu(emptyBody, { clientX: 200, clientY: 200 });
    fireEvent(emptyBody, ev);

    // 默认行为（WebView2 原生菜单）必须被阻止，而不是"稍后再拦"。
    expect(ev.defaultPrevented).toBe(true);

    // 真实组件菜单出现（FreeMenu → DropdownMenu role="menu"）。
    const menu = await screen.findByRole("menu");
    expect(menu).toBeTruthy();
    const labels = menuLabels();
    expect(labels).toContain(NEW_FOLDER);
    expect(labels).toContain(NEW_FILE);
    expect(labels).toContain(PASTE);
    expect(labels).toContain(REFRESH);
    expect(labels).toContain(HIDDEN);
    // 不能是真空窗格菜单。
    expect(labels).not.toContain(BROWSE_FOLDER);
  });

  it("空目录新建文件夹：菜单 → 对话框 → 真实创建目录入口", async () => {
    const DIR = "D:\\r11-empty-newdir";
    bridgeMocks.fsListDir.mockResolvedValue({ path: DIR, truncated: false, hasMore: false, nextOffset: 0, entries: [] });
    hydrateDir(DIR);
    renderPane();

    const emptyBody = (await screen.findByText(EMPTY_DIR_TEXT)).closest(".fw-body-empty") as HTMLElement;
    fireEvent.contextMenu(emptyBody, { clientX: 80, clientY: 90 });
    await screen.findByRole("menu");
    fireEvent.click(screen.getByText(NEW_FOLDER));

    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("fw.menu.newFolderName");
    fireEvent.change(input, { target: { value: "新建目录" } });
    fireEvent.click(within(dialog).getByText("common.confirm"));

    await waitFor(() => expect(bridgeMocks.fsCreateDir).toHaveBeenCalledTimes(1));
    expect(bridgeMocks.fsCreateDir).toHaveBeenCalledWith(DIR, "新建目录");
    // 创建成功后按既有逻辑刷新目录（仍由 dirCache 拉取，不改业务入口）。
    await waitFor(() => expect(bridgeMocks.fsListDir.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("搜索无结果：同样走空白菜单，且不清搜索、不动已有选择", async () => {
    const DIR = "D:\\r11-search";
    bridgeMocks.fsListDir.mockResolvedValue({
      path: DIR,
      truncated: false,
      hasMore: false,
      nextOffset: 0,
      entries: [entry("alpha.txt", "file"), entry("beta.txt", "file")],
    });
    hydrateDir(DIR);
    renderPane();

    await screen.findByText("alpha.txt");
    act(() => {
      useFilesWorkspaceStore.getState().patchTab("pane-1", "tab-1", { search: "没有这个文件" });
    });
    const emptyBody = (await screen.findByText(NO_MATCH_TEXT)).closest(".fw-body-empty") as HTMLElement;

    // 既有选择状态（搜索前选中的文件）不应被右键清掉。
    const selected = `${DIR}\\alpha.txt`;
    act(() => {
      useFilesWorkspaceStore.getState().setSelection("pane-1", [selected], selected);
    });

    const ev = createEvent.contextMenu(emptyBody, { clientX: 150, clientY: 160 });
    fireEvent(emptyBody, ev);
    expect(ev.defaultPrevented).toBe(true);

    await screen.findByRole("menu");
    const labels = menuLabels();
    expect(labels).toContain(NEW_FOLDER);
    expect(labels).toContain(REFRESH);

    const tab = useFilesWorkspaceStore.getState().panes["pane-1"].tabs[0];
    expect(tab.search).toBe("没有这个文件");
    expect(useFilesWorkspaceStore.getState().selection["pane-1"]?.paths).toEqual([selected]);
  });
});

describe("B 正常目录列表空白处右键（原行为回归）", () => {
  it("仍使用目录空白菜单，不因空态修复而改变", async () => {
    const DIR = "D:\\r11-normal";
    bridgeMocks.fsListDir.mockResolvedValue({
      path: DIR,
      truncated: false,
      hasMore: false,
      nextOffset: 0,
      entries: [entry("readme.md", "file"), entry("sub", "dir")],
    });
    hydrateDir(DIR);
    const { container } = renderPane();

    await screen.findByText("readme.md");
    const body = container.querySelector(".fw-body") as HTMLElement;
    expect(body).toBeTruthy();

    const ev = createEvent.contextMenu(body, { clientX: 300, clientY: 320 });
    fireEvent(body, ev);
    expect(ev.defaultPrevented).toBe(true);

    await screen.findByRole("menu");
    const labels = menuLabels();
    expect(labels).toContain(NEW_FOLDER);
    expect(labels).toContain(NEW_FILE);
    expect(labels).toContain(REFRESH);
    expect(labels).not.toContain(ENTER);
  });
});

describe("A 文件夹条目右键", () => {
  it("仍走 onEntryContextMenu：识别为文件夹并给出条目菜单", async () => {
    const DIR = "D:\\r11-entries";
    bridgeMocks.fsListDir.mockResolvedValue({
      path: DIR,
      truncated: false,
      hasMore: false,
      nextOffset: 0,
      entries: [entry("empty-sub", "dir"), entry("note.txt", "file")],
    });
    hydrateDir(DIR);
    renderPane();

    const row = (await screen.findByText("empty-sub")).closest("[data-fw-path]") as HTMLElement;
    expect(row).toBeTruthy();
    const ev = createEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    fireEvent(row, ev);
    expect(ev.defaultPrevented).toBe(true);

    await screen.findByRole("menu");
    const labels = menuLabels();
    expect(labels).toContain(ENTER);
    expect(labels).toContain("fw.menu.copy");
    expect(labels).toContain("fw.menu.cut");
    expect(labels).toContain("fw.menu.rename");
    expect(labels).toContain("fw.menu.delete");
    // 条目菜单不能退化成目录内容区菜单。
    expect(labels).not.toContain(NEW_FOLDER);
    expect(labels).not.toContain(NEW_FILE);
    // 右键未选项会把该项设为唯一选择（既有行为）。
    expect(useFilesWorkspaceStore.getState().selection["pane-1"]?.paths).toEqual([`${DIR}\\empty-sub`]);
    // 不复制真正空窗格菜单。
    expect(labels).not.toContain(BROWSE_FOLDER);
  });
});

describe("D 真·空窗格（tabs=[]）不被误当成空目录", () => {
  it("不渲染 .fw-body-empty，右键仍走空窗格专用菜单", async () => {
    hydrateEmptyPane();
    const { container } = renderPane();

    const blank = (await screen.findByText("fw.pane.noDir")).closest(".fw-empty-pane") as HTMLElement;
    expect(blank).toBeTruthy();
    expect(container.querySelector(".fw-body-empty")).toBeNull();

    const ev = createEvent.contextMenu(blank, { clientX: 20, clientY: 30 });
    fireEvent(blank, ev);
    expect(ev.defaultPrevented).toBe(true);

    await screen.findByRole("menu");
    const labels = menuLabels();
    expect(labels).toContain(BROWSE_FOLDER);
    expect(labels).toContain("fw.pane.inputPath");
    // 空窗格没有目录内容区，不能出现新建文件夹。
    expect(labels).not.toContain(NEW_FOLDER);
  });
});
