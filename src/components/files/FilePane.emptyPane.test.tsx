/**
 * @vitest-environment jsdom
 *
 * R10 Agent B：空窗格 / 空白标签三态 UI 回归。
 * - A 真·空窗格（tabs=[]）：顶部有「更多」与「关闭空窗格」，点击调 closeEmptyPane；
 *   totalPanes<=1 时禁用并给出 closeLast 提示；右键含打开文件夹/输入路径/关闭空窗格。
 * - B 空白标签（tabs>0 但无 dirPath）：渲染标签栏，不显示「关闭空窗格」（关闭走标签 x）。
 * - 标签 Tooltip 含名称 + 完整 openedPath，title 也指向 openedPath。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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

// 测试 mock 的 useLocale 为 identity（t(key)=key），断言直接用 locale key。
const CLOSE_LABEL = "fw.pane.closeEmptyPane";
const START = "D:\\origin\\Proj";

type SeedTab = { tabId: string; path: string; openedPath?: string; history?: string[] };
type SeedPane = { paneId: string; tabs: SeedTab[]; activeTabId: string | null };

/** 用最小持久化状态建立单窗格 / 双窗格布局。 */
function hydrateLayout(panes: SeedPane[], activePaneId = "pane-1"): void {
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
  useFilesWorkspaceStore.getState().hydrate({ tree, panes, activePaneId } as never, "global");
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

const emptyPane = (paneId: string): SeedPane => ({ paneId, tabs: [], activeTabId: null });
const dirPane = (paneId: string, tabId: string, path: string): SeedPane => ({
  paneId,
  tabs: [{ tabId, path }],
  activeTabId: tabId,
});

beforeEach(() => {
  memSettings.settings = {};
  bridgeMocks.fsListDir.mockResolvedValue({ path: START, truncated: false, entries: [] });
  bridgeMocks.fsDirSignature.mockResolvedValue({ exists: true, isDir: true, modifiedMs: 1 });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await useFilesWorkspaceStore.getState().flushPending();
  await __flushFilesWorkspaceWrites();
});

describe("A 真·空窗格（tabs=[]）", () => {
  it("渲染关闭按钮，点击调用 closeEmptyPane(paneId)", async () => {
    hydrateLayout([
      emptyPane("pane-1"),
      dirPane("pane-2", "t2", "D:\\other"),
    ]);
    const spy = vi.spyOn(useFilesWorkspaceStore.getState(), "closeEmptyPane").mockReturnValue(true);
    renderPane();

    const button = (await screen.findByLabelText(CLOSE_LABEL)) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("data-tip")).toBe(CLOSE_LABEL);
    fireEvent.click(button);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("pane-1");
  });

  it("只有一个窗格时关闭按钮禁用，提示至少保留一个区域", async () => {
    hydrateLayout([emptyPane("pane-1")]);
    renderPane();

    const button = (await screen.findByLabelText(CLOSE_LABEL)) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("data-tip")).toBe("fw.pane.closeLast");
  });

  it("右键菜单含打开文件夹 / 输入路径 / 关闭空窗格", async () => {
    hydrateLayout([
      emptyPane("pane-1"),
      dirPane("pane-2", "t2", "D:\\other"),
    ]);
    const { container } = renderPane();

    const blank = container.querySelector(".fw-empty-pane") as HTMLElement;
    expect(blank).toBeTruthy();
    fireEvent.contextMenu(blank, { clientX: 12, clientY: 24 });

    await screen.findByRole("menu");
    const labels = screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
    expect(labels).toContain("fw.pane.browseFolder");
    expect(labels).toContain("fw.pane.inputPath");
    expect(labels).toContain(CLOSE_LABEL);
  });

  it("只有一个窗格时右键菜单的关闭项禁用", async () => {
    hydrateLayout([emptyPane("pane-1")]);
    const { container } = renderPane();

    fireEvent.contextMenu(container.querySelector(".fw-empty-pane") as HTMLElement, {
      clientX: 12,
      clientY: 24,
    });
    await screen.findByRole("menu");
    const closeItem = screen
      .getAllByRole("menuitem")
      .find((el) => el.textContent === CLOSE_LABEL) as HTMLElement;
    expect(closeItem).toBeTruthy();
    expect(closeItem.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("B 空白标签（tabs>0 但无有效 dirPath）", () => {
  it("渲染标签栏，但不显示关闭空窗格按钮", async () => {
    hydrateLayout([
      {
        paneId: "pane-1",
        tabs: [{ tabId: "t1", path: "", openedPath: START, history: [] }],
        activeTabId: "t1",
      },
    ]);
    renderPane();

    expect(await screen.findByText("Proj")).toBeTruthy();
    expect(screen.queryByLabelText(CLOSE_LABEL)).toBeNull();
    // 关闭入口是标签自身的 x。
    expect(screen.getByRole("tab").querySelector(".fw-tab-close")).toBeTruthy();
  });

  it("标签 Tooltip 为「名称 + 完整起始路径」两行，title 指向 openedPath", async () => {
    hydrateLayout([
      {
        paneId: "pane-1",
        tabs: [{ tabId: "t1", path: "", openedPath: START, history: [] }],
        activeTabId: "t1",
      },
    ]);
    renderPane();

    const label = await screen.findByText("Proj");
    expect(label.getAttribute("data-tip")).toBe(`Proj\n${START}`);
    expect(label.getAttribute("title")).toBe(START);
  });
});
